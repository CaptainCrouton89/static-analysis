import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pLimit from "p-limit";
import path from "path";
import { Node, SyntaxKind, ts } from "ts-morph";
import { z } from "zod";
import {
  analyzeSourceFile,
  analyzeSymbolDeclaration,
  extractSymbolInfo,
  findSymbolAtPosition,
  findSymbolOnLine,
} from "./analyzer.js";
import { AnalysisError, ErrorCode, Location } from "./types.js";
import {
  checkMemoryUsage,
  createProject,
  findClosestTsConfig,
  findFiles,
  findProjectRoot,
  nodeToLocation,
  validatePath,
} from "./utils.js";

const limit = pLimit(5);

// Tool schemas
export const analyzeFileSchema = z.object({
  filePath: z.string(),
  analysisType: z
    .enum(["symbols", "dependencies", "all"])
    .optional()
    .default("all"),
  includeDefinition: z.boolean().optional().default(false),
});

export const findReferencesSchema = z.object({
  filePath: z.string(),
  position: z.object({
    line: z.number(),
    character: z.number().optional(),
  }),
  includeDeclaration: z.boolean().optional().default(false),
  scope: z.enum(["file", "project"]).optional().default("project"),
  maxResults: z.number().optional().default(100),
});

export const findReferencesBySymbolSchema = z.object({
  symbolIdentifier: z.object({
    filePath: z.string(),
    symbolName: z.string(),
    line: z.number(),
  }),
  maxResults: z.number().optional().default(100),
});

export const analyzeSymbolSchema = z.object({
  symbolIdentifier: z.object({
    filePath: z.string(),
    symbolName: z.string(),
    line: z.number(),
  }),
  maxTypeLength: z.number().optional().default(Number.MAX_SAFE_INTEGER),
});

export const getCompilationErrorsSchema = z.object({
  path: z.string(),
  includeWarnings: z.boolean().optional().default(true),
  includeInfo: z.boolean().optional().default(false),
  filePattern: z.string().optional().default("**/*.{ts,tsx}"),
  maxFiles: z.number().optional().default(25),
  verbosity: z
    .enum(["minimal", "normal", "detailed"])
    .optional()
    .default("normal"),
});

export const getFileTreeSchema = z.object({
  path: z.string(),
  maxDepth: z.number().optional().default(100),
  includeNodeModules: z.boolean().optional().default(false),
  filePattern: z.string().optional().default("**/*.{ts,tsx,js,jsx}"),
  maxFiles: z.number().optional().default(100),
});

// Tool implementations
export async function analyzeFile(params: z.infer<typeof analyzeFileSchema>) {
  validatePath(params.filePath, params.includeDefinition);
  await checkMemoryUsage();

  const projectRoot = findProjectRoot(params.filePath);
  const project = createProject(projectRoot, params.includeDefinition);
  const sourceFile = project.addSourceFileAtPath(params.filePath);

  const result = analyzeSourceFile(
    sourceFile,
    params.analysisType,
    1,
    false,
    params.includeDefinition
  );

  const lines = [`## ${path.relative(process.cwd(), params.filePath)}`];

  if (result.symbols.length > 0) {
    lines.push(`\n**Symbols (${result.symbols.length}):**`);
    result.symbols.forEach((sym) => {
      let symbolLine = `- \`${sym.name}\` (${sym.kind}) - line ${
        sym.location.line + 1
      }`;
      if (sym.definition && sym.definition.file !== sym.location.file) {
        const relativePath = path.relative(process.cwd(), sym.definition.file);
        symbolLine += ` → defined in \`${relativePath}:${
          sym.definition.line + 1
        }\``;
      }
      lines.push(symbolLine);
    });
  }

  if (result.imports.length > 0) {
    lines.push(`\n**Imports (${result.imports.length}):**`);
    result.imports.forEach((imp) => {
      lines.push(`- \`${imp.moduleSpecifier}\` - ${imp.symbols.join(", ")}`);
    });
  }

  if (result.exports.length > 0) {
    lines.push(`\n**Exports (${result.exports.length}):**`);
    result.exports.forEach((exp) => {
      lines.push(`- \`${exp}\``);
    });
  }

  if (result.diagnostics.length > 0) {
    lines.push(`\n**Issues (${result.diagnostics.length}):**`);
    result.diagnostics.forEach((diag) => {
      lines.push(`- ${diag.severity}: ${diag.message}`);
    });
  }

  return lines.join("\n");
}

export async function findReferences(
  params: z.infer<typeof findReferencesSchema>
) {
  validatePath(params.filePath);

  const projectRoot = findProjectRoot(params.filePath);
  const project = createProject(projectRoot);
  const sourceFile = project.addSourceFileAtPath(params.filePath);

  let node: Node | undefined;

  if (params.position.character !== undefined) {
    // Use exact position if character is specified
    node = findSymbolAtPosition(sourceFile, {
      line: params.position.line,
      character: params.position.character,
    });
  } else {
    // Use line-based search with fallback
    node = findSymbolOnLine(sourceFile, params.position.line);
  }

  if (!node) {
    throw new AnalysisError({
      code: ErrorCode.FILE_NOT_FOUND,
      message: "No symbol found at position",
      details: {
        file: params.filePath,
        position: params.position,
      },
    });
  }

  const symbol = node.getSymbol();
  if (!symbol) {
    throw new AnalysisError({
      code: ErrorCode.PARSE_ERROR,
      message: "No symbol information available",
      details: {
        file: params.filePath,
        position: params.position,
      },
    });
  }

  const references: Array<{
    location: Location;
    kind: "read" | "write" | "call" | "import" | "declaration";
    context: string;
  }> = [];

  if (params.scope === "file") {
    // Find references within the file
    const identifier = Node.isIdentifier(node)
      ? node
      : node.getFirstDescendantByKind(SyntaxKind.Identifier);
    if (identifier && Node.isIdentifier(identifier)) {
      const refs = identifier.findReferences();
      refs.forEach((ref) => {
        ref.getReferences().forEach((refEntry) => {
          const refNode = refEntry.getNode();

          // Filter out declaration if includeDeclaration is false
          if (!params.includeDeclaration && refEntry.isDefinition()) {
            return;
          }

          references.push({
            location: nodeToLocation(refNode),
            kind: getReferenceKind(refNode),
            context: getContext(refNode),
          });
        });
      });
    }
  } else {
    // Project-wide search - load more files into the project
    const files = await findFiles("**/*.{ts,tsx}", process.cwd());
    await Promise.all(
      files.slice(0, 50).map((file) =>
        limit(async () => {
          try {
            project.addSourceFileAtPath(file);
          } catch (error) {
            console.error(`Error loading ${file}:`, error);
          }
        })
      )
    );

    const identifier = Node.isIdentifier(node)
      ? node
      : node.getFirstDescendantByKind(SyntaxKind.Identifier);
    if (identifier && Node.isIdentifier(identifier)) {
      const refs = identifier.findReferences();
      refs.forEach((ref) => {
        ref.getReferences().forEach((refEntry) => {
          const refNode = refEntry.getNode();

          // Filter out declaration if includeDeclaration is false
          if (!params.includeDeclaration && refEntry.isDefinition()) {
            return;
          }

          references.push({
            location: nodeToLocation(refNode),
            kind: getReferenceKind(refNode),
            context: getContext(refNode),
          });
        });
      });
    }
  }

  const symbolInfo = extractSymbolInfo(node, false, false);

  const limitedReferences = references.slice(0, params.maxResults);

  const lines = [`## ${symbolInfo!.name} References (${references.length})`];

  limitedReferences.forEach((ref) => {
    lines.push(
      `- \`${path.relative(process.cwd(), ref.location.file)}:${
        ref.location.position.line + 1
      }\` ${ref.kind}`
    );
  });

  return lines.join("\n");
}

export async function findReferencesBySymbol(
  params: z.infer<typeof findReferencesBySymbolSchema>
) {
  const { symbolIdentifier } = params;
  validatePath(symbolIdentifier.filePath);

  const projectRoot = findProjectRoot(symbolIdentifier.filePath);
  const project = createProject(projectRoot);
  const sourceFile = project.addSourceFileAtPath(symbolIdentifier.filePath);

  // Find the symbol by name at the specified line (convert to 0-based indexing)
  const line = sourceFile.getFullText().split("\n")[symbolIdentifier.line - 1];
  const symbolIndex = line.indexOf(symbolIdentifier.symbolName);

  if (symbolIndex === -1) {
    throw new AnalysisError({
      code: ErrorCode.FILE_NOT_FOUND,
      message: `Symbol '${symbolIdentifier.symbolName}' not found at line ${symbolIdentifier.line}. Use 'analyze_file' first to find the correct line number for this symbol.`,
      details: {
        file: symbolIdentifier.filePath,
        symbolName: symbolIdentifier.symbolName,
        line: symbolIdentifier.line,
      },
    });
  }

  const position = { line: symbolIdentifier.line - 1, character: symbolIndex };
  const node = findSymbolAtPosition(sourceFile, position);

  if (!node) {
    throw new AnalysisError({
      code: ErrorCode.FILE_NOT_FOUND,
      message: "No symbol found at calculated position",
      details: {
        file: symbolIdentifier.filePath,
        position,
        symbolName: symbolIdentifier.symbolName,
      },
    });
  }

  const symbol = node.getSymbol();
  if (!symbol || symbol.getName() !== symbolIdentifier.symbolName) {
    throw new AnalysisError({
      code: ErrorCode.PARSE_ERROR,
      message: `Symbol name mismatch. Expected '${
        symbolIdentifier.symbolName
      }', found '${symbol?.getName()}'`,
      details: {
        file: symbolIdentifier.filePath,
        expected: symbolIdentifier.symbolName,
        found: symbol?.getName(),
      },
    });
  }

  const references: Array<{
    location: { file: string; line: number };
    kind: "read" | "write" | "call" | "import" | "declaration";
    context: string;
  }> = [];

  // Project-wide search - load more files into the project
  const files = await findFiles("**/*.{ts,tsx}", process.cwd());
  await Promise.all(
    files.slice(0, 50).map((file) =>
      limit(async () => {
        try {
          project.addSourceFileAtPath(file);
        } catch (error) {
          console.error(`Error loading ${file}:`, error);
        }
      })
    )
  );

  const identifier = Node.isIdentifier(node)
    ? node
    : node.getFirstDescendantByKind(SyntaxKind.Identifier);

  if (identifier && Node.isIdentifier(identifier)) {
    const refs = identifier.findReferences();
    refs.forEach((ref) => {
      ref.getReferences().forEach((refEntry) => {
        const refNode = refEntry.getNode();
        const nodeLocation = nodeToLocation(refNode);

        references.push({
          location: {
            file: path.relative(process.cwd(), nodeLocation.file),
            line: nodeLocation.position.line + 1, // Convert back to 1-based
          },
          kind: refEntry.isDefinition()
            ? "declaration"
            : getReferenceKind(refNode),
          context: getContext(refNode),
        });
      });
    });
  }

  const symbolInfo = extractSymbolInfo(node, false, false);

  const limitedReferences = references.slice(0, params.maxResults);

  // Generate markdown output
  const lines = [`## ${symbolInfo!.name} References (${references.length})`];

  limitedReferences.forEach((ref) => {
    lines.push(`- \`${ref.location.file}:${ref.location.line}\` ${ref.kind}`);
  });

  return lines.join("\n");
}

export async function analyzeSymbol(
  params: z.infer<typeof analyzeSymbolSchema>
) {
  const { symbolIdentifier } = params;
  validatePath(symbolIdentifier.filePath);

  const projectRoot = findProjectRoot(symbolIdentifier.filePath);
  const project = createProject(projectRoot, true); // Enable definition lookup
  const sourceFile = project.addSourceFileAtPath(symbolIdentifier.filePath);

  // Find the symbol by name at the specified line (convert to 0-based indexing)
  const line = sourceFile.getFullText().split("\n")[symbolIdentifier.line - 1];
  let symbolIndex = line.indexOf(symbolIdentifier.symbolName);

  // If not found directly, try to find it as part of a qualified name (e.g., Stripe.Subscription)
  if (symbolIndex === -1) {
    // Look for the symbol name preceded by a dot or followed by various TypeScript syntax
    const patterns = [
      `.${symbolIdentifier.symbolName}`, // e.g., Stripe.Subscription
      `<${symbolIdentifier.symbolName}`, // e.g., Array<Subscription>
      ` ${symbolIdentifier.symbolName}`, // e.g., implements Subscription
      `:${symbolIdentifier.symbolName}`, // e.g., extends :Subscription
      `(${symbolIdentifier.symbolName}`, // e.g., new (Subscription)
    ];

    for (const pattern of patterns) {
      const idx = line.indexOf(pattern);
      if (idx !== -1) {
        // Adjust index to point to the actual symbol name
        symbolIndex = idx + pattern.length - symbolIdentifier.symbolName.length;
        break;
      }
    }
  }

  if (symbolIndex === -1) {
    throw new AnalysisError({
      code: ErrorCode.FILE_NOT_FOUND,
      message: `Symbol '${symbolIdentifier.symbolName}' not found at line ${symbolIdentifier.line}. Use 'analyze_file' first to find the correct line number for this symbol.`,
      details: {
        file: symbolIdentifier.filePath,
        symbolName: symbolIdentifier.symbolName,
        line: symbolIdentifier.line,
      },
    });
  }

  const position = { line: symbolIdentifier.line - 1, character: symbolIndex };
  const node = findSymbolAtPosition(sourceFile, position);

  if (!node) {
    throw new AnalysisError({
      code: ErrorCode.FILE_NOT_FOUND,
      message: "No symbol found at calculated position",
      details: {
        file: symbolIdentifier.filePath,
        position,
        symbolName: symbolIdentifier.symbolName,
      },
    });
  }

  // For type references, try to get the actual type symbol
  let symbol = node.getSymbol();

  // If we're looking at a type reference (e.g., Stripe.Subscription), navigate to the actual type
  if (Node.isTypeReference(node)) {
    const typeSymbol = node.getType().getSymbol();
    if (typeSymbol) {
      symbol = typeSymbol;
    }
  } else if (Node.isIdentifier(node) || Node.isQualifiedName(node)) {
    // Try to get the type of the identifier
    const type = node.getType();
    const typeSymbol = type.getSymbol();
    if (
      typeSymbol &&
      (typeSymbol.getName() === symbolIdentifier.symbolName ||
        typeSymbol.getName().endsWith(`.${symbolIdentifier.symbolName}`))
    ) {
      symbol = typeSymbol;
    }
  }

  // If symbol doesn't match but we have a qualified name, try to resolve it
  if (symbol && symbol.getName() !== symbolIdentifier.symbolName) {
    // Check if this is a namespace access (e.g., clicking on Subscription in Stripe.Subscription)
    const type = node.getType();
    const typeSymbol = type.getSymbol();
    if (typeSymbol && typeSymbol.getName() === symbolIdentifier.symbolName) {
      symbol = typeSymbol;
    }
  }

  if (!symbol) {
    throw new AnalysisError({
      code: ErrorCode.PARSE_ERROR,
      message: `Unable to resolve symbol '${symbolIdentifier.symbolName}'`,
      details: {
        file: symbolIdentifier.filePath,
        symbolName: symbolIdentifier.symbolName,
        line: symbolIdentifier.line,
      },
    });
  }

  // Try to find the definition/declaration node
  let declarationNode = node;
  const declarations = symbol.getDeclarations();
  if (declarations.length > 0) {
    // Find the primary declaration (not just a reference)
    const primaryDecl = declarations.find(
      (decl) =>
        Node.isFunctionDeclaration(decl) ||
        Node.isClassDeclaration(decl) ||
        Node.isInterfaceDeclaration(decl) ||
        Node.isTypeAliasDeclaration(decl) ||
        Node.isEnumDeclaration(decl) ||
        Node.isVariableDeclaration(decl) ||
        Node.isMethodDeclaration(decl) ||
        Node.isPropertyDeclaration(decl)
    );

    if (primaryDecl) {
      declarationNode = primaryDecl;
    }
  }

  const symbolInfo = analyzeSymbolDeclaration(
    declarationNode,
    params.maxTypeLength
  );

  if (!symbolInfo) {
    throw new AnalysisError({
      code: ErrorCode.PARSE_ERROR,
      message: "Unable to analyze symbol declaration",
      details: {
        file: symbolIdentifier.filePath,
        symbolName: symbolIdentifier.symbolName,
      },
    });
  }

  // Format output
  const lines = [`## ${symbolInfo.name} (${symbolInfo.kind})`];
  lines.push(
    `**Location:** \`${path.relative(
      process.cwd(),
      symbolInfo.location.file
    )}:${symbolInfo.location.position.line + 1}\``
  );
  lines.push(`**Type:** \`${symbolInfo.type}\``);

  if (symbolInfo.generics && symbolInfo.generics.length > 0) {
    lines.push(`**Generics:** \`<${symbolInfo.generics.join(", ")}>\``);
  }

  if (symbolInfo.parameters && symbolInfo.parameters.length > 0) {
    lines.push(`\n**Parameters:**`);
    symbolInfo.parameters.forEach((param) => {
      const optional = param.optional ? "?" : "";
      const defaultVal = param.defaultValue ? ` = ${param.defaultValue}` : "";
      lines.push(`- \`${param.name}${optional}: ${param.type}${defaultVal}\``);
    });
  }

  if (symbolInfo.returnType) {
    lines.push(`\n**Returns:** \`${symbolInfo.returnType}\``);
  }

  if (symbolInfo.members && symbolInfo.members.length > 0) {
    lines.push(`\n**Members (${symbolInfo.members.length}):**`);
    symbolInfo.members.forEach((member) => {
      const visibility =
        member.visibility !== "public" ? `${member.visibility} ` : "";
      const staticModifier = member.static ? "static " : "";
      const optional = member.optional ? "?" : "";
      lines.push(
        `- ${visibility}${staticModifier}\`${member.name}${optional}\`: \`${member.type}\` (${member.kind})`
      );
    });
  }

  if (
    symbolInfo.signature &&
    (symbolInfo.kind === "type" || symbolInfo.kind === "function")
  ) {
    lines.push(`\n**Full Signature:**`);
    lines.push(`\`\`\`typescript\n${symbolInfo.signature}\n\`\`\``);
  }

  return lines.join("\n");
}

export async function getCompilationErrors(
  params: z.infer<typeof getCompilationErrorsSchema>
) {
  const startTime = Date.now();
  await checkMemoryUsage();

  const fs = await import("fs");
  const isDirectory =
    fs.existsSync(params.path) && fs.statSync(params.path).isDirectory();

  // Find the closest tsconfig.json to ensure proper configuration
  const closestTsConfig = findClosestTsConfig(params.path);
  const projectRoot = closestTsConfig || findProjectRoot(params.path);
  const project = createProject(projectRoot);

  let filesToAnalyze: string[] = [];

  if (isDirectory) {
    const files = await findFiles(params.filePattern, params.path);
    const filesWithStats = await Promise.all(
      files.map(async (file) => {
        try {
          const stats = await fs.promises.stat(file);
          return { path: file, mtime: stats.mtime };
        } catch (error) {
          return { path: file, mtime: new Date(0) };
        }
      })
    );

    filesWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    filesToAnalyze = filesWithStats
      .slice(0, params.maxFiles)
      .map((f) => f.path);
  } else {
    validatePath(params.path);
    filesToAnalyze = [params.path];
  }

  const errors: Array<{
    file: string;
    message: string;
    line: number;
    code?: string;
    context?: string;
    severity: "error" | "warning" | "info";
  }> = [];

  let totalErrors = 0;
  let totalWarnings = 0;

  await Promise.all(
    filesToAnalyze.map((filePath) =>
      limit(async () => {
        try {
          const sourceFile = project.addSourceFileAtPath(filePath);
          const allDiagnostics = sourceFile.getPreEmitDiagnostics();

          const filteredDiagnostics = allDiagnostics.filter((diag) => {
            const severity = getDiagnosticSeverity(diag.getCategory());

            // Check if this diagnostic should be skipped based on skipLibCheck
            const diagFile = diag.getSourceFile();
            const shouldSkip =
              project.getCompilerOptions().skipLibCheck &&
              diagFile &&
              (diagFile.getFilePath().includes("node_modules") ||
                diagFile.getFilePath().endsWith(".d.ts") ||
                diagFile.isDeclarationFile());

            if (shouldSkip) return false;

            if (severity === "error") return true;
            if (severity === "warning" && params.includeWarnings) return true;
            if (severity === "info" && params.includeInfo) return true;
            return false;
          });

          filteredDiagnostics.forEach((diag) => {
            const severity = getDiagnosticSeverity(diag.getCategory());
            if (severity === "error") totalErrors++;
            else if (severity === "warning") totalWarnings++;

            if (severity === "error" || params.verbosity !== "minimal") {
              const lineNumber = diag.getLineNumber();
              const start = diag.getStart();
              const length = diag.getLength();

              let context: string | undefined;
              if (
                params.verbosity === "detailed" &&
                lineNumber &&
                start !== undefined &&
                length !== undefined
              ) {
                const lines = sourceFile.getFullText().split("\n");
                const lineIndex = lineNumber - 1;
                const contextLines: string[] = [];
                const startLine = Math.max(0, lineIndex - 1);
                const endLine = Math.min(lines.length - 1, lineIndex + 1);

                for (let i = startLine; i <= endLine; i++) {
                  const prefix = i === lineIndex ? "> " : "  ";
                  contextLines.push(`${prefix}${i + 1} | ${lines[i]}`);
                }

                if (lineIndex === lineNumber - 1) {
                  const column =
                    sourceFile.getLineAndColumnAtPos(start).column - 1;
                  const indicator =
                    "  " +
                    " ".repeat(String(lineNumber).length + 3 + column) +
                    "^".repeat(
                      Math.min(length, lines[lineIndex].length - column)
                    );
                  contextLines.push(indicator);
                }

                context = contextLines.join("\n");
              }

              const messageText = diag.getMessageText();
              const message =
                typeof messageText === "string"
                  ? messageText
                  : messageText.getMessageText?.() || messageText.toString();

              const severity = getDiagnosticSeverity(diag.getCategory());
              errors.push({
                file: path.relative(projectRoot, filePath),
                message,
                line: lineNumber || 0,
                code: diag.getCode()?.toString(),
                context: params.verbosity === "detailed" ? context : undefined,
                severity,
              });
            }
          });
        } catch (error) {
          console.error(`Error analyzing ${filePath}:`, error);
        }
      })
    )
  );

  // Early return for no errors case
  if (totalErrors === 0 && params.verbosity === "minimal") {
    return {
      hasErrors: false,
      totalErrors: 0,
      totalWarnings,
    };
  }

  if (totalErrors === 0 && totalWarnings === 0) {
    return {
      hasErrors: false,
      totalErrors: 0,
      totalWarnings: 0,
      filesAnalyzed: filesToAnalyze.length,
    };
  }

  // Sort errors by severity and file
  errors.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  const limitedErrors = errors.slice(
    0,
    params.verbosity === "minimal" ? 5 : errors.length
  );

  const lines = [`## Compilation Analysis`];
  lines.push(
    `**${totalErrors}** errors, **${totalWarnings}** warnings in **${filesToAnalyze.length}** files`
  );

  if (limitedErrors.length > 0) {
    lines.push("\n**Issues:**");
    limitedErrors.forEach((err) => {
      lines.push(
        `- ${err.severity}: \`${path.relative(process.cwd(), err.file)}:${
          err.line
        }\` - ${err.message}`
      );
    });

    if (errors.length > limitedErrors.length) {
      lines.push(
        `\n*... and ${errors.length - limitedErrors.length} more issues*`
      );
    }
  }

  if (params.verbosity !== "minimal") {
    lines.push(`\n*Analysis completed in ${Date.now() - startTime}ms*`);
  }

  return lines.join("\n");
}

function getDiagnosticSeverity(
  category: ts.DiagnosticCategory
): "error" | "warning" | "info" {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    default:
      return "info";
  }
}

// Helper functions
function getContext(node: Node, lines: number = 3): string {
  const sourceFile = node.getSourceFile();
  const start = node.getStartLineNumber();
  const end = Math.min(start + lines, sourceFile.getEndLineNumber());

  const lineTexts = [];
  for (let i = start; i <= end; i++) {
    lineTexts.push(sourceFile.getFullText().split("\n")[i - 1]);
  }

  return lineTexts.join("\n");
}

function getReferenceKind(node: Node): "read" | "write" | "call" | "import" {
  const parent = node.getParent();

  if (parent && Node.isCallExpression(parent)) return "call";
  if (parent && Node.isImportSpecifier(parent)) return "import";
  if (
    parent &&
    Node.isBinaryExpression(parent) &&
    parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken
  ) {
    return "write";
  }

  return "read";
}

export async function getFileTree(params: z.infer<typeof getFileTreeSchema>) {
  await checkMemoryUsage();

  const fs = await import("fs");
  const isDirectory =
    fs.existsSync(params.path) && fs.statSync(params.path).isDirectory();

  if (!isDirectory) {
    throw new AnalysisError({
      code: ErrorCode.FILE_NOT_FOUND,
      message: "Path must be a directory",
      details: { file: params.path },
    });
  }

  const projectRoot = findProjectRoot(params.path);
  const project = createProject(projectRoot);

  // Find all files matching the pattern
  let files = await findFiles(params.filePattern, params.path);

  // Filter out node_modules if requested
  if (!params.includeNodeModules) {
    files = files.filter((file) => !file.includes("node_modules"));
  }

  // Sort by path and limit
  files.sort();
  files = files.slice(0, params.maxFiles);

  // Build tree structure
  interface TreeNode {
    name: string;
    type: "directory" | "file";
    path: string;
    children?: TreeNode[];
    imports?: string[];
    exports?: string[];
    symbols?: Array<{ name: string; kind: string }>;
  }

  const root: TreeNode = {
    name: path.basename(params.path),
    type: "directory",
    path: params.path,
    children: [],
  };

  const pathToNode = new Map<string, TreeNode>();
  pathToNode.set(params.path, root);

  // Process each file
  await Promise.all(
    files.map((filePath) =>
      limit(async () => {
        try {
          const relativePath = path.relative(params.path, filePath);
          const pathParts = relativePath.split(path.sep);

          // Create directory nodes as needed
          let currentNode = root;
          for (let i = 0; i < pathParts.length - 1; i++) {
            const dirName = pathParts[i];
            const dirPath = path.join(
              params.path,
              ...pathParts.slice(0, i + 1)
            );

            if (!pathToNode.has(dirPath)) {
              const dirNode: TreeNode = {
                name: dirName,
                type: "directory",
                path: dirPath,
                children: [],
              };

              if (!currentNode.children) currentNode.children = [];
              currentNode.children.push(dirNode);
              pathToNode.set(dirPath, dirNode);
              currentNode = dirNode;
            } else {
              currentNode = pathToNode.get(dirPath)!;
            }
          }

          // Add the file node
          const fileName = pathParts[pathParts.length - 1];
          const fileNode: TreeNode = {
            name: fileName,
            type: "file",
            path: filePath,
          };

          // Analyze the file
          try {
            const sourceFile = project.addSourceFileAtPath(filePath);
            const analysis = analyzeSourceFile(
              sourceFile,
              "all",
              1,
              false,
              false
            );

            // Add imports
            if (analysis.imports.length > 0) {
              fileNode.imports = analysis.imports.map((imp) =>
                imp.isTypeOnly
                  ? `type:${imp.moduleSpecifier}`
                  : imp.moduleSpecifier
              );
            }

            // Add exports
            if (analysis.exports.length > 0) {
              fileNode.exports = analysis.exports;
            }

            // Add only exported symbols
            const exportedSymbols = analysis.symbols.filter((sym) => {
              // Check if this symbol is in the exports list
              return analysis.exports.includes(sym.name);
            });

            if (exportedSymbols.length > 0) {
              fileNode.symbols = exportedSymbols.map((sym) => ({
                name: sym.name,
                kind: sym.kind,
              }));
            }
          } catch (error) {
            // File might not be valid TypeScript
            console.error(`Error analyzing ${filePath}:`, error);
          }

          if (!currentNode.children) currentNode.children = [];
          currentNode.children.push(fileNode);
        } catch (error) {
          console.error(`Error processing ${filePath}:`, error);
        }
      })
    )
  );

  // Sort children at each level
  function sortTree(node: TreeNode) {
    if (node.children) {
      node.children.sort((a, b) => {
        // Directories first, then files
        if (a.type !== b.type) {
          return a.type === "directory" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      // Recursively sort children
      node.children.forEach((child) => {
        if (child.type === "directory") {
          sortTree(child);
        }
      });
    }
  }

  sortTree(root);

  // Generate markdown output
  const lines: string[] = [`# File Tree: ${root.name}`];

  function renderTree(
    node: TreeNode,
    indent: string = "",
    isLast: boolean = true,
    depth: number = 0
  ) {
    if (depth > params.maxDepth) return;

    const prefix = indent + (isLast ? "└── " : "├── ");
    const nextIndent = indent + (isLast ? "    " : "│   ");

    if (depth > 0) {
      const icon = node.type === "directory" ? "📁" : "📄";
      lines.push(`${prefix}${icon} **${node.name}**`);

      // Add file details
      if (node.type === "file") {
        // Imports
        if (node.imports && node.imports.length > 0) {
          lines.push(`${nextIndent}├─ Imports: ${node.imports.join(", ")}`);
        }

        // Exports
        if (node.exports && node.exports.length > 0) {
          lines.push(`${nextIndent}├─ Exports: ${node.exports.join(", ")}`);
        }

        // Symbols
        if (node.symbols && node.symbols.length > 0) {
          const symbolGroups = new Map<string, string[]>();
          node.symbols.forEach((sym) => {
            if (!symbolGroups.has(sym.kind)) {
              symbolGroups.set(sym.kind, []);
            }
            symbolGroups.get(sym.kind)!.push(sym.name);
          });

          symbolGroups.forEach((syms, kind) => {
            lines.push(`${nextIndent}└─ ${kind}s: ${syms.join(", ")}`);
          });
        }
      }
    }

    // Render children
    if (node.children && node.children.length > 0) {
      node.children.forEach((child, index) => {
        const childIsLast = index === node.children!.length - 1;
        renderTree(
          child,
          depth === 0 ? "" : nextIndent,
          childIsLast,
          depth + 1
        );
      });
    }
  }

  // Start rendering from root's children
  if (root.children && root.children.length > 0) {
    root.children.forEach((child, index) => {
      renderTree(child, "", index === root.children!.length - 1, 1);
    });
  }

  // Add summary
  const totalFiles = files.length;
  const totalDirs =
    Array.from(pathToNode.values()).filter((n) => n.type === "directory")
      .length - 1;

  lines.push("");
  lines.push(`## Summary`);
  lines.push(`- **Directories**: ${totalDirs}`);
  lines.push(`- **Files**: ${totalFiles}`);

  return lines.join("\n");
}

// Tool definitions for modular registration
interface Tool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (params: unknown) => Promise<{
    content: Array<{
      type: string;
      text: string;
    }>;
    isError?: boolean;
  }>;
}

export const tools: Tool[] = [
  {
    name: "analyze_file",
    description: "Analyze a single TypeScript and get all symbols, imports, and exports. The best way to quickly understand a file using minimal context.",
    schema: analyzeFileSchema._def.shape(),
    handler: async (params: unknown) => {
      try {
        const validated = analyzeFileSchema.parse(params);
        const result = await analyzeFile(validated);
        return {
          content: [
            {
              type: "text" as const,
              text: result,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  },
  {
    name: "analyze_symbol",
    description: "Get detailed symbol analysis including declaration, parameters, return types, and members for functions, classes, interfaces, and types. Perfect for understanding symbol signatures from 3rd party libraries.",
    schema: analyzeSymbolSchema._def.shape(),
    handler: async (params: unknown) => {
      try {
        const validated = analyzeSymbolSchema.parse(params);
        const result = await analyzeSymbol(validated);
        return {
          content: [
            {
              type: "text" as const,
              text: result,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  },
  {
    name: "find_references",
    description: "Find all references to a symbol using stable symbol identifier. Use this for perfect accuracy when searching for usage, imports, and declarations of a symbol. This is the most accurate way to find references to a symbol and understand its usage across the codebase.",
    schema: findReferencesSchema._def.shape(),
    handler: async (params: unknown) => {
      try {
        const validated = findReferencesSchema.parse(params);
        const result = await findReferences(validated);
        return {
          content: [
            {
              type: "text" as const,
              text: result,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  },
  {
    name: "get_compilation_errors",
    description: "Get TypeScript compilation errors for a file or directory. Use this instead of building the project to get errors.",
    schema: getCompilationErrorsSchema._def.shape(),
    handler: async (params: unknown) => {
      try {
        const validated = getCompilationErrorsSchema.parse(params);
        const result = await getCompilationErrors(validated);
        return {
          content: [
            {
              type: "text" as const,
              text:
                typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  },
  {
    name: "get_file_tree",
    description: "Generate a file tree for a directory showing imports, exports, and symbols for each file. Perfect for understanding project structure and dependencies at a glance.",
    schema: getFileTreeSchema._def.shape(),
    handler: async (params: unknown) => {
      try {
        const validated = getFileTreeSchema.parse(params);
        const result = await getFileTree(validated);
        return {
          content: [
            {
              type: "text" as const,
              text: result,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  },
];

// Register tools based on configuration
export function registerTools(server: McpServer, enabledTools?: string[]) {
  const toolsToRegister =
    enabledTools && enabledTools.length > 0
      ? tools.filter((tool) => enabledTools.includes(tool.name))
      : tools;

  for (const tool of toolsToRegister) {
    // @ts-expect-error - handler signature mismatch with McpServer's expected type
    server.tool(tool.name, tool.description, tool.schema, tool.handler);
  }

  console.error(
    `Registered ${toolsToRegister.length} tools: ${toolsToRegister
      .map((t) => t.name)
      .join(", ")}`
  );
}
