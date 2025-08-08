import pLimit from "p-limit";
import path from "path";
import { Node, SyntaxKind, ts } from "ts-morph";
import { z } from "zod";
import {
  analyzeSourceFile,
  extractSymbolInfo,
  findSymbolAtPosition,
  findSymbolOnLine,
} from "./analyzer.js";
import { AnalysisError, ErrorCode, Location } from "./types.js";
import {
  checkMemoryUsage,
  createProject,
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
  validatePath(params.filePath);
  await checkMemoryUsage();

  const project = createProject();
  const sourceFile = project.addSourceFileAtPath(params.filePath);

  const result = analyzeSourceFile(sourceFile, params.analysisType, 1, false);

  return {
    symbols: result.symbols,
    imports: result.imports,
    exports: result.exports,
    diagnostics: result.diagnostics,
  };
}

export async function findReferences(
  params: z.infer<typeof findReferencesSchema>
) {
  validatePath(params.filePath);

  const project = createProject();
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

  const symbolInfo = extractSymbolInfo(node, false);

  return {
    references: references.slice(0, params.maxResults),
    symbol: symbolInfo!,
    totalReferences: references.length,
  };
}

export async function findReferencesBySymbol(
  params: z.infer<typeof findReferencesBySymbolSchema>
) {
  const { symbolIdentifier } = params;
  validatePath(symbolIdentifier.filePath);

  const project = createProject();
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

  const symbolInfo = extractSymbolInfo(node, false);

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

export async function getCompilationErrors(
  params: z.infer<typeof getCompilationErrorsSchema>
) {
  const startTime = Date.now();
  await checkMemoryUsage();

  const fs = await import("fs");
  const isDirectory =
    fs.existsSync(params.path) && fs.statSync(params.path).isDirectory();

  // Extract project root to use proper tsconfig.json
  const projectRoot = findProjectRoot(params.path);
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

              errors.push({
                file: path.relative(projectRoot, filePath),
                message,
                line: lineNumber || 0,
                code: diag.getCode()?.toString(),
                context: params.verbosity === "detailed" ? context : undefined,
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

  const result: any = {
    hasErrors: totalErrors > 0,
    totalErrors,
    totalWarnings,
    errors: errors.slice(0, params.verbosity === "minimal" ? 5 : errors.length),
  };

  if (params.verbosity !== "minimal") {
    result.filesAnalyzed = filesToAnalyze.length;
    result.analysisTimeMs = Date.now() - startTime;
  }

  return result;
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
