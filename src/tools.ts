import pLimit from "p-limit";
import path from "path";
import { Node, SyntaxKind, ts } from "ts-morph";
import { z } from "zod";
import {
  analyzeSourceFile,
  extractSymbolInfo,
  findSymbolAtPosition,
  findSymbolOnLine,
  analyzeSymbolDeclaration,
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

// Tool implementations
export async function analyzeFile(params: z.infer<typeof analyzeFileSchema>) {
  validatePath(params.filePath, params.includeDefinition);
  await checkMemoryUsage();

  const projectRoot = findProjectRoot(params.filePath);
  const project = createProject(projectRoot, params.includeDefinition);
  const sourceFile = project.addSourceFileAtPath(params.filePath);

  const result = analyzeSourceFile(sourceFile, params.analysisType, 1, false, params.includeDefinition);

  const lines = [`## ${path.relative(process.cwd(), params.filePath)}`];
  
  if (result.symbols.length > 0) {
    lines.push(`\n**Symbols (${result.symbols.length}):**`);
    result.symbols.forEach(sym => {
      let symbolLine = `- \`${sym.name}\` (${sym.kind}) - line ${sym.location.line + 1}`;
      if (sym.definition && sym.definition.file !== sym.location.file) {
        const relativePath = path.relative(process.cwd(), sym.definition.file);
        symbolLine += ` → defined in \`${relativePath}:${sym.definition.line + 1}\``;
      }
      lines.push(symbolLine);
    });
  }
  
  if (result.imports.length > 0) {
    lines.push(`\n**Imports (${result.imports.length}):**`);
    result.imports.forEach(imp => {
      lines.push(`- \`${imp.moduleSpecifier}\` - ${imp.symbols.join(', ')}`);
    });
  }
  
  if (result.exports.length > 0) {
    lines.push(`\n**Exports (${result.exports.length}):**`);
    result.exports.forEach(exp => {
      lines.push(`- \`${exp}\``);
    });
  }
  
  if (result.diagnostics.length > 0) {
    lines.push(`\n**Issues (${result.diagnostics.length}):**`);
    result.diagnostics.forEach(diag => {
      lines.push(`- ${diag.severity}: ${diag.message}`);
    });
  }
  
  return lines.join('\n');
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
      character: params.position.character
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
  
  const lines = [
    `## ${symbolInfo!.name} References (${references.length})`
  ];
  
  limitedReferences.forEach(ref => {
    lines.push(`- \`${path.relative(process.cwd(), ref.location.file)}:${ref.location.position.line + 1}\` ${ref.kind}`);
  });
  
  return lines.join('\n');
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
      message: `Symbol '${symbolIdentifier.symbolName}' not found at line ${symbolIdentifier.line}`,
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
          kind: refEntry.isDefinition() ? "declaration" : getReferenceKind(refNode),
          context: getContext(refNode),
        });
      });
    });
  }

  const symbolInfo = extractSymbolInfo(node, false, false);

  const limitedReferences = references.slice(0, params.maxResults);
  
  // Generate markdown output
  const lines = [
    `## ${symbolInfo!.name} References (${references.length})`
  ];
  
  limitedReferences.forEach(ref => {
    lines.push(`- \`${ref.location.file}:${ref.location.line}\` ${ref.kind}`);
  });
  
  return lines.join('\n');
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
  const symbolIndex = line.indexOf(symbolIdentifier.symbolName);

  if (symbolIndex === -1) {
    throw new AnalysisError({
      code: ErrorCode.FILE_NOT_FOUND,
      message: `Symbol '${symbolIdentifier.symbolName}' not found at line ${symbolIdentifier.line}`,
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

  // Try to find the definition/declaration node
  let declarationNode = node;
  const declarations = symbol.getDeclarations();
  if (declarations.length > 0) {
    // Find the primary declaration (not just a reference)
    const primaryDecl = declarations.find(decl => 
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

  const symbolInfo = analyzeSymbolDeclaration(declarationNode, params.maxTypeLength);

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
  lines.push(`**Location:** \`${path.relative(process.cwd(), symbolInfo.location.file)}:${symbolInfo.location.position.line + 1}\``);
  lines.push(`**Type:** \`${symbolInfo.type}\``);

  if (symbolInfo.generics && symbolInfo.generics.length > 0) {
    lines.push(`**Generics:** \`<${symbolInfo.generics.join(', ')}>\``);
  }

  if (symbolInfo.parameters && symbolInfo.parameters.length > 0) {
    lines.push(`\n**Parameters:**`);
    symbolInfo.parameters.forEach(param => {
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
    symbolInfo.members.forEach(member => {
      const visibility = member.visibility !== "public" ? `${member.visibility} ` : "";
      const staticModifier = member.static ? "static " : "";
      const optional = member.optional ? "?" : "";
      lines.push(`- ${visibility}${staticModifier}\`${member.name}${optional}\`: \`${member.type}\` (${member.kind})`);
    });
  }

  if (symbolInfo.signature && (symbolInfo.kind === "type" || symbolInfo.kind === "function")) {
    lines.push(`\n**Full Signature:**`);
    lines.push(`\`\`\`typescript\n${symbolInfo.signature}\n\`\`\``);
  }

  return lines.join('\n');
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

  const limitedErrors = errors.slice(0, params.verbosity === "minimal" ? 5 : errors.length);
  
  const lines = [`## Compilation Analysis`];
  lines.push(`**${totalErrors}** errors, **${totalWarnings}** warnings in **${filesToAnalyze.length}** files`);
  
  if (limitedErrors.length > 0) {
    lines.push('\n**Issues:**');
    limitedErrors.forEach(err => {
      lines.push(`- ${err.severity}: \`${path.relative(process.cwd(), err.file)}:${err.line}\` - ${err.message}`);
    });
    
    if (errors.length > limitedErrors.length) {
      lines.push(`\n*... and ${errors.length - limitedErrors.length} more issues*`);
    }
  }
  
  if (params.verbosity !== "minimal") {
    lines.push(`\n*Analysis completed in ${Date.now() - startTime}ms*`);
  }
  
  return lines.join('\n');
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
