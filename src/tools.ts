import pLimit from "p-limit";
import path from "path";
import { Node, Project, SourceFile, SyntaxKind, ts } from "ts-morph";
import { z } from "zod";
import {
  analyzeSourceFile,
  extractMembers,
  extractSymbolInfo,
  findSymbolAtPosition,
  getTypeHierarchy,
} from "./analyzer.js";
import { cacheManager, CacheManager } from "./cache.js";
import {
  AnalysisError,
  CodeSmellCategory,
  ErrorCode,
  Layer,
  Location,
  SymbolInfo,
  TypeInfo,
} from "./types.js";
import {
  checkMemoryUsage,
  createProject,
  findFiles,
  findProjectRoot,
  getNodeComplexity,
  getTypeString,
  matchesScope,
  nodeToLocation,
  positionToOffset,
  timeoutLimits,
  validatePath,
  withTimeout,
} from "./utils.js";

const limit = pLimit(5);

// Tool schemas
export const analyzeFileSchema = z.object({
  filePath: z.string(),
  analysisType: z.enum(["symbols", "dependencies", "complexity", "all"]),
  depth: z.number().min(1).max(3).default(2),
  includePrivate: z.boolean().optional().default(false),
  includeNodeModules: z.boolean().optional().default(false),
  outputFormat: z
    .enum(["summary", "detailed", "full"])
    .optional()
    .default("summary"),
});

export const searchSymbolsSchema = z.object({
  query: z.string(),
  searchType: z.enum(["text", "semantic", "ast-pattern"]),
  scope: z
    .object({
      includeFiles: z.array(z.string()).optional(),
      excludeFiles: z.array(z.string()).optional(),
      fileTypes: z.array(z.string()).optional(),
    })
    .optional(),
  symbolTypes: z
    .array(
      z.enum([
        "class",
        "interface",
        "enum",
        "function",
        "method",
        "property",
        "variable",
        "parameter",
        "type",
        "namespace",
        "module",
      ])
    )
    .optional(),
  maxResults: z.number().optional().default(50),
  includeReferences: z.boolean().optional().default(false),
});

export const getSymbolInfoSchema = z.object({
  filePath: z.string(),
  position: z.object({
    line: z.number(),
    character: z.number(),
  }),
  includeRelationships: z.boolean().optional().default(true),
  includeUsages: z.boolean().optional().default(false),
  depth: z.number().optional().default(2),
});

export const findReferencesSchema = z.object({
  filePath: z.string(),
  position: z.object({
    line: z.number(),
    character: z.number(),
  }),
  includeDeclaration: z.boolean().optional().default(false),
  scope: z.enum(["file", "project"]).optional().default("project"),
  maxResults: z.number().optional().default(100),
});

export const analyzeDependenciesSchema = z.object({
  filePath: z.string().optional(),
  direction: z.enum(["imports", "exports", "both"]),
  depth: z.number().optional().default(2),
  includeNodeModules: z.boolean().optional().default(false),
  groupBy: z.enum(["module", "file", "none"]).optional().default("module"),
});

export const findPatternsSchema = z.object({
  pattern: z.string(),
  patternType: z.enum(["ast", "semantic", "regex"]),
  scope: z
    .object({
      includeFiles: z.array(z.string()).optional(),
      excludeFiles: z.array(z.string()).optional(),
      fileTypes: z.array(z.string()).optional(),
    })
    .optional(),
  maxResults: z.number().optional().default(100),
  includeContext: z.boolean().optional().default(true),
});

export const detectCodeSmellsSchema = z.object({
  filePath: z.string().optional(),
  categories: z
    .array(
      z.enum([
        "complexity",
        "duplication",
        "coupling",
        "naming",
        "unused-code",
        "async-issues",
      ])
    )
    .optional(),
  threshold: z
    .object({
      complexity: z.number().optional().default(10),
      fileSize: z.number().optional().default(300),
      functionSize: z.number().optional().default(50),
    })
    .optional(),
});

export const extractContextSchema = z.object({
  filePath: z.string(),
  position: z
    .object({
      line: z.number(),
      character: z.number(),
    })
    .optional(),
  contextType: z.enum(["function", "class", "module", "related"]),
  maxTokens: z.number().optional().default(2000),
  includeImports: z.boolean().optional().default(true),
  includeTypes: z.boolean().optional().default(true),
  followReferences: z.boolean().optional().default(false),
});

export const summarizeCodebaseSchema = z.object({
  rootPath: z.string().optional(),
  includeMetrics: z.boolean().optional().default(true),
  includeArchitecture: z.boolean().optional().default(true),
  maxDepth: z.number().optional().default(5),
});

export const getCompilationErrorsSchema = z.object({
  path: z.string(),
  includeWarnings: z.boolean().optional().default(true),
  includeInfo: z.boolean().optional().default(false),
  filePattern: z.string().optional().default("**/*.{ts,tsx}"),
  maxFiles: z.number().optional().default(25),
  verbosity: z.enum(["minimal", "normal", "detailed"]).optional().default("normal"),
});

// Tool implementations
export async function analyzeFile(params: z.infer<typeof analyzeFileSchema>) {
  const startTime = Date.now();
  validatePath(params.filePath);
  await checkMemoryUsage();

  // Generate cache key
  const cacheKey = cacheManager.generateCacheKey(
    "analyzeFile",
    params.filePath,
    params.analysisType,
    params.depth,
    params.includePrivate,
    params.outputFormat
  );

  // Check cache
  const cached = await cacheManager.getCachedAnalysis(cacheKey);
  if (cached) {
    return cached;
  }

  // Extract project root from file path to use proper tsconfig.json
  const projectRoot = findProjectRoot(params.filePath);
  const project = createProject(projectRoot);

  // Try to get cached source file
  const cachedFile = await cacheManager.getCachedFile(params.filePath);
  const sourceFile =
    cachedFile?.sourceFile || project.addSourceFileAtPath(params.filePath);

  if (!cachedFile) {
    await cacheManager.setCachedFile(params.filePath, sourceFile);
  }

  const result = await withTimeout(
    Promise.resolve(
      analyzeSourceFile(
        sourceFile,
        params.analysisType,
        params.depth,
        params.includePrivate
      )
    ),
    "analyzeFile",
    timeoutLimits.singleFile
  );

  const filePath = sourceFile.getFilePath();
  const fileSize = sourceFile.getFullText().length;
  const stats = await cacheManager.getFileStats(filePath);

  const summary = {
    totalSymbols: result.symbols.length,
    complexity: result.complexity,
    dependencies: result.imports.map((imp) => imp.moduleSpecifier),
  };

  let response;
  if (params.outputFormat === "summary") {
    response = {
      summary,
      metadata: {
        fileSize,
        lastModified: new Date(stats.lastModified).toISOString(),
        analysisTimeMs: Date.now() - startTime,
      },
    };
  } else {
    response = {
      summary,
      symbols:
        params.outputFormat === "full"
          ? result.symbols
          : result.symbols.slice(0, 10),
      diagnostics: result.diagnostics,
      metadata: {
        fileSize,
        lastModified: new Date(stats.lastModified).toISOString(),
        analysisTimeMs: Date.now() - startTime,
      },
    };
  }

  // Cache the result
  await cacheManager.setCachedAnalysis(cacheKey, response);

  return response;
}

export async function searchSymbols(
  params: z.infer<typeof searchSymbolsSchema>
) {
  const startTime = Date.now();
  await checkMemoryUsage();

  // Generate cache key for the search
  const cacheKey = cacheManager.generateCacheKey(
    "searchSymbols",
    params.query,
    params.searchType,
    params.scope,
    params.symbolTypes,
    params.maxResults
  );

  // Check cache
  const cached = await cacheManager.getCachedAnalysis(cacheKey);
  if (cached && !params.includeReferences) {
    return cached;
  }

  const project = createProject();
  const matches: Array<{
    symbol: SymbolInfo;
    score: number;
    context: string;
    references?: Location[];
  }> = [];

  const files = await findFiles("**/*.{ts,tsx}", process.cwd());
  const filteredFiles = files.filter((file) =>
    matchesScope(file, params.scope)
  );

  // Determine cache strategy based on project size
  const cacheStrategy = CacheManager.getCacheStrategy(files.length);

  await Promise.all(
    filteredFiles.map((file) =>
      limit(async () => {
        try {
          // Try to get cached source file
          const cachedFile = await cacheManager.getCachedFile(file);
          const sourceFile =
            cachedFile?.sourceFile || project.addSourceFileAtPath(file);

          if (!cachedFile) {
            await cacheManager.setCachedFile(file, sourceFile);
          }

          const analysis = analyzeSourceFile(sourceFile, "symbols", 1, false);

          for (const symbol of analysis.symbols) {
            if (
              params.symbolTypes &&
              !params.symbolTypes.includes(symbol.kind)
            ) {
              continue;
            }

            const score = calculateSearchScore(
              symbol,
              params.query,
              params.searchType
            );
            if (score > 0) {
              const node = sourceFile.getDescendantAtPos(
                positionToOffset(sourceFile, symbol.location.position)
              );

              matches.push({
                symbol,
                score,
                context: node ? getContext(node) : "",
                references: params.includeReferences ? [] : undefined,
              });
            }
          }
        } catch (error) {
          console.error(`Error analyzing ${file}:`, error);
        }
      })
    )
  );

  matches.sort((a, b) => b.score - a.score);
  const topMatches = matches.slice(0, params.maxResults);

  const result = {
    matches: topMatches,
    totalMatches: matches.length,
    searchTimeMs: Date.now() - startTime,
  };

  // Cache the result if references are not included
  if (!params.includeReferences) {
    await cacheManager.setCachedAnalysis(cacheKey, result);
  }

  return result;
}

export async function getSymbolInfo(
  params: z.infer<typeof getSymbolInfoSchema>
) {
  validatePath(params.filePath);
  await checkMemoryUsage();

  // Generate cache key
  const cacheKey = cacheManager.generateCacheKey(
    "getSymbolInfo",
    params.filePath,
    params.position,
    params.includeRelationships,
    params.includeUsages,
    params.depth
  );

  // Check cache
  const cached = await cacheManager.getCachedAnalysis(cacheKey);
  if (cached) {
    return cached;
  }

  const project = createProject();

  // Try to get cached source file
  const cachedFile = await cacheManager.getCachedFile(params.filePath);
  const sourceFile =
    cachedFile?.sourceFile || project.addSourceFileAtPath(params.filePath);

  if (!cachedFile) {
    await cacheManager.setCachedFile(params.filePath, sourceFile);
  }

  const node = findSymbolAtPosition(sourceFile, params.position);

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

  const symbolInfo = extractSymbolInfo(node, false);
  if (!symbolInfo) {
    throw new AnalysisError({
      code: ErrorCode.PARSE_ERROR,
      message: "Could not extract symbol information",
      details: {
        file: params.filePath,
        position: params.position,
      },
    });
  }

  if (params.includeRelationships && params.depth > 1) {
    const hierarchy = getTypeHierarchy(node, "both", params.depth);
    if (hierarchy.length > 0) {
      symbolInfo.relationships = {
        ...symbolInfo.relationships,
        extends: hierarchy
          .filter((t) => t.name !== symbolInfo.name)
          .map((t) => ({
            name: t.name,
            location: t.location,
            kind: t.kind as any,
          })),
      };
    }
  }

  // Cache the result
  await cacheManager.setCachedAnalysis(cacheKey, symbolInfo);

  return symbolInfo;
}

export async function findReferences(
  params: z.infer<typeof findReferencesSchema>
) {
  validatePath(params.filePath);

  const project = createProject();
  const sourceFile = project.addSourceFileAtPath(params.filePath);
  const node = findSymbolAtPosition(sourceFile, params.position);

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
    kind: "read" | "write" | "call" | "import";
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

export async function analyzeDependencies(
  params: z.infer<typeof analyzeDependenciesSchema>
) {
  const project = createProject();
  const nodes: Array<{
    id: string;
    type: "file" | "module" | "external";
    metrics: {
      imports: number;
      exports: number;
      complexity: number;
    };
  }> = [];

  const edges: Array<{
    from: string;
    to: string;
    type: "import" | "export" | "reexport";
    symbols?: string[];
  }> = [];

  if (params.filePath) {
    validatePath(params.filePath);
    const sourceFile = project.addSourceFileAtPath(params.filePath);
    await analyzeFileDependencies(sourceFile, nodes, edges, params);
  } else {
    const files = await findFiles("**/*.{ts,tsx}", process.cwd());

    await Promise.all(
      files.slice(0, 50).map((file) =>
        limit(async () => {
          try {
            const sourceFile = project.addSourceFileAtPath(file);
            await analyzeFileDependencies(sourceFile, nodes, edges, params);
          } catch (error) {
            console.error(`Error analyzing ${file}:`, error);
          }
        })
      )
    );
  }

  return { nodes, edges };
}

export async function findPatterns(params: z.infer<typeof findPatternsSchema>) {
  const startTime = Date.now();
  const project = createProject();
  const matches: Array<{
    pattern: string;
    location: Location;
    match: string;
    context?: string;
  }> = [];

  const files = await findFiles("**/*.{ts,tsx}", process.cwd());
  const filteredFiles = files.filter((file) =>
    matchesScope(file, params.scope)
  );

  await Promise.all(
    filteredFiles.map((file) =>
      limit(async () => {
        try {
          const sourceFile = project.addSourceFileAtPath(file);

          if (params.patternType === "regex") {
            // Text-based regex pattern matching
            const text = sourceFile.getFullText();
            const regex = new RegExp(params.pattern, "gm");
            let match;

            while ((match = regex.exec(text)) !== null) {
              const pos = sourceFile.getLineAndColumnAtPos(match.index);
              const endPos = sourceFile.getLineAndColumnAtPos(
                match.index + match[0].length
              );

              matches.push({
                pattern: params.pattern,
                location: {
                  file: sourceFile.getFilePath(),
                  position: { line: pos.line - 1, character: pos.column - 1 },
                  endPosition: {
                    line: endPos.line - 1,
                    character: endPos.column - 1,
                  },
                },
                match: match[0],
                context: params.includeContext
                  ? getTextContext(text, match.index)
                  : undefined,
              });

              if (matches.length >= params.maxResults) break;
            }
          } else if (params.patternType === "ast") {
            // AST pattern matching
            sourceFile.forEachDescendant((node) => {
              if (matches.length >= params.maxResults) return;

              if (matchesAstPattern(node, params.pattern)) {
                matches.push({
                  pattern: params.pattern,
                  location: nodeToLocation(node),
                  match: node.getText(),
                  context: params.includeContext
                    ? getContext(node, 5)
                    : undefined,
                });
              }
            });
          } else if (params.patternType === "semantic") {
            // Semantic pattern matching
            sourceFile.forEachDescendant((node) => {
              if (matches.length >= params.maxResults) return;

              if (matchesSemanticPattern(node, params.pattern)) {
                matches.push({
                  pattern: params.pattern,
                  location: nodeToLocation(node),
                  match: node.getText(),
                  context: params.includeContext
                    ? getContext(node, 5)
                    : undefined,
                });
              }
            });
          }
        } catch (error) {
          console.error(`Error analyzing ${file}:`, error);
        }
      })
    )
  );

  return {
    matches: matches.slice(0, params.maxResults),
    totalMatches: matches.length,
    searchTimeMs: Date.now() - startTime,
  };
}

export async function detectCodeSmells(
  params: z.infer<typeof detectCodeSmellsSchema>
) {
  const startTime = Date.now();
  const project = createProject();
  const smells: Array<{
    type: CodeSmellCategory;
    severity: "low" | "medium" | "high";
    location: Location;
    message: string;
    suggestion?: string;
  }> = [];

  const files = params.filePath
    ? [params.filePath]
    : await findFiles("**/*.{ts,tsx}", process.cwd());
  const categories = params.categories || [
    "complexity",
    "duplication",
    "coupling",
    "naming",
    "unused-code",
    "async-issues",
  ];

  await Promise.all(
    files.map((file) =>
      limit(async () => {
        try {
          validatePath(file);
          const sourceFile = project.addSourceFileAtPath(file);

          if (categories.includes("complexity")) {
            detectComplexitySmells(sourceFile, smells, params.threshold);
          }

          if (categories.includes("naming")) {
            detectNamingSmells(sourceFile, smells);
          }

          if (categories.includes("unused-code")) {
            detectUnusedCode(sourceFile, smells);
          }

          if (categories.includes("async-issues")) {
            detectAsyncIssues(sourceFile, smells);
          }

          if (categories.includes("coupling")) {
            detectCouplingIssues(sourceFile, smells);
          }

          if (categories.includes("duplication")) {
            // Duplication detection would require comparing across files
            // This is a placeholder for now
          }
        } catch (error) {
          console.error(`Error analyzing ${file}:`, error);
        }
      })
    )
  );

  return {
    smells: smells.sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    }),
    summary: {
      total: smells.length,
      byCategory: categories.reduce((acc, cat) => {
        acc[cat] = smells.filter((s) => s.type === cat).length;
        return acc;
      }, {} as Record<CodeSmellCategory, number>),
      bySeverity: {
        high: smells.filter((s) => s.severity === "high").length,
        medium: smells.filter((s) => s.severity === "medium").length,
        low: smells.filter((s) => s.severity === "low").length,
      },
    },
    analysisTimeMs: Date.now() - startTime,
  };
}

export async function extractContext(
  params: z.infer<typeof extractContextSchema>
) {
  validatePath(params.filePath);

  const project = createProject();
  const sourceFile = project.addSourceFileAtPath(params.filePath);

  let targetNode: Node | undefined;

  if (params.position) {
    targetNode = findSymbolAtPosition(sourceFile, params.position);
    if (!targetNode) {
      throw new AnalysisError({
        code: ErrorCode.FILE_NOT_FOUND,
        message: "No symbol found at position",
        details: {
          file: params.filePath,
          position: params.position,
        },
      });
    }
  }

  const context: {
    mainContext: string;
    imports?: string[];
    relatedTypes?: TypeInfo[];
    dependencies?: string[];
    tokenCount: number;
  } = {
    mainContext: "",
    tokenCount: 0,
  };

  if (params.contextType === "function" && targetNode) {
    context.mainContext = extractFunctionContext(
      targetNode,
      params.includeTypes
    );
  } else if (params.contextType === "class" && targetNode) {
    context.mainContext = extractClassContext(targetNode, params.includeTypes);
  } else if (params.contextType === "module") {
    context.mainContext = extractModuleContext(sourceFile, params.includeTypes);
  } else if (params.contextType === "related" && targetNode) {
    context.mainContext = extractRelatedContext(
      targetNode,
      project,
      params.followReferences
    );
  }

  // Include imports if requested
  if (params.includeImports) {
    context.imports = sourceFile
      .getImportDeclarations()
      .map((imp) => imp.getText());
  }

  // Track token count (rough estimate)
  context.tokenCount = Math.floor(context.mainContext.length / 4);

  // Truncate if exceeding token limit
  if (context.tokenCount > params.maxTokens) {
    const ratio = params.maxTokens / context.tokenCount;
    const newLength = Math.floor(context.mainContext.length * ratio);
    context.mainContext =
      context.mainContext.substring(0, newLength) + "\n... (truncated)";
    context.tokenCount = params.maxTokens;
  }

  return context;
}

export async function summarizeCodebase(
  params: z.infer<typeof summarizeCodebaseSchema>
) {
  const startTime = Date.now();
  const project = createProject();
  const rootPath = params.rootPath || process.cwd();

  const summary: {
    overview: {
      totalFiles: number;
      totalLines: number;
      languages: Record<string, number>;
    };
    metrics?: {
      complexity: {
        average: number;
        highest: Array<{ file: string; complexity: number }>;
      };
      dependencies: {
        internal: number;
        external: number;
        mostImported: Array<{ module: string; count: number }>;
      };
    };
    architecture?: {
      layers: Layer[];
      patterns: string[];
      entryPoints: string[];
    };
  } = {
    overview: {
      totalFiles: 0,
      totalLines: 0,
      languages: {},
    },
  };

  const files = await findFiles("**/*.{ts,tsx,js,jsx}", rootPath);
  summary.overview.totalFiles = files.length;

  const complexityData: Array<{ file: string; complexity: number }> = [];
  const importCounts: Record<string, number> = {};
  const fileLines: number[] = [];

  await Promise.all(
    files.slice(0, 100).map((file) =>
      limit(async () => {
        try {
          const ext = path.extname(file);
          summary.overview.languages[ext] =
            (summary.overview.languages[ext] || 0) + 1;

          const sourceFile = project.addSourceFileAtPath(file);
          const lines = sourceFile.getEndLineNumber();
          fileLines.push(lines);

          if (params.includeMetrics) {
            const analysis = analyzeSourceFile(sourceFile, "all", 1, false);
            complexityData.push({
              file: path.relative(rootPath, file),
              complexity: analysis.complexity,
            });

            analysis.imports.forEach((imp) => {
              const module = imp.moduleSpecifier;
              importCounts[module] = (importCounts[module] || 0) + 1;
            });
          }
        } catch (error) {
          console.error(`Error analyzing ${file}:`, error);
        }
      })
    )
  );

  summary.overview.totalLines = fileLines.reduce(
    (sum, lines) => sum + lines,
    0
  );

  if (params.includeMetrics && complexityData.length > 0) {
    const totalComplexity = complexityData.reduce(
      (sum, item) => sum + item.complexity,
      0
    );
    const avgComplexity = totalComplexity / complexityData.length;

    complexityData.sort((a, b) => b.complexity - a.complexity);

    const externalImports = Object.entries(importCounts).filter(
      ([mod]) => !mod.startsWith(".") && !mod.startsWith("/")
    );
    const internalImports = Object.entries(importCounts).filter(
      ([mod]) => mod.startsWith(".") || mod.startsWith("/")
    );

    summary.metrics = {
      complexity: {
        average: Math.round(avgComplexity * 10) / 10,
        highest: complexityData.slice(0, 5),
      },
      dependencies: {
        internal: internalImports.length,
        external: externalImports.length,
        mostImported: Object.entries(importCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([module, count]) => ({ module, count })),
      },
    };
  }

  if (params.includeArchitecture) {
    // Detect common patterns and entry points
    const patterns: string[] = [];
    const entryPoints: string[] = [];

    // Check for common entry points
    if (files.some((f) => f.endsWith("/index.ts") || f.endsWith("/index.js"))) {
      entryPoints.push("index");
    }
    if (files.some((f) => f.endsWith("/main.ts") || f.endsWith("/main.js"))) {
      entryPoints.push("main");
    }
    if (files.some((f) => f.endsWith("/app.ts") || f.endsWith("/app.js"))) {
      entryPoints.push("app");
    }

    // Detect patterns based on folder structure
    const hasComponents = files.some((f) => f.includes("/components/"));
    const hasServices = files.some((f) => f.includes("/services/"));
    const hasControllers = files.some((f) => f.includes("/controllers/"));
    const hasModels = files.some((f) => f.includes("/models/"));

    if (hasComponents) patterns.push("Component-based");
    if (hasServices && hasControllers) patterns.push("MVC");
    if (hasModels) patterns.push("Domain-driven");

    summary.architecture = {
      layers: detectArchitecturalLayers(files),
      patterns,
      entryPoints,
    };
  }

  return {
    summary,
    analysisTimeMs: Date.now() - startTime,
  };
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
    // Find all TypeScript files in the directory
    const files = await findFiles(params.filePattern, params.path);
    
    // Sort files by modification time (most recent first)
    const filesWithStats = await Promise.all(
      files.map(async (file) => {
        try {
          const stats = await fs.promises.stat(file);
          return {
            path: file,
            mtime: stats.mtime
          };
        } catch (error) {
          // If we can't stat the file, give it a very old date
          return {
            path: file,
            mtime: new Date(0)
          };
        }
      })
    );
    
    filesWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    filesToAnalyze = filesWithStats.slice(0, params.maxFiles).map(f => f.path);
  } else {
    // Single file
    validatePath(params.path);
    filesToAnalyze = [params.path];
  }

  // Collect all diagnostics from all files
  const allFileDiagnostics: Array<{
    file: string;
    diagnostics: Array<{
      message: string;
      severity: "error" | "warning" | "info";
      location: Location;
      code?: string;
      context?: string;
    }>;
  }> = [];

  let totalErrors = 0;
  let totalWarnings = 0;
  let totalInfo = 0;

  await Promise.all(
    filesToAnalyze.map((filePath) =>
      limit(async () => {
        try {
          // Add the source file to the project
          const sourceFile = project.addSourceFileAtPath(filePath);

          // Get all diagnostics
          const allDiagnostics = sourceFile.getPreEmitDiagnostics();

          // Filter diagnostics based on parameters
          const filteredDiagnostics = allDiagnostics.filter((diag) => {
            const severity = getDiagnosticSeverity(diag.getCategory());
            if (severity === "error") return true;
            if (severity === "warning" && params.includeWarnings) return true;
            if (severity === "info" && params.includeInfo) return true;
            return false;
          });

          if (filteredDiagnostics.length === 0) return;

          // Map diagnostics to our format with context
          const diagnostics = filteredDiagnostics.map((diag) => {
            const lineNumber = diag.getLineNumber();
            const start = diag.getStart();
            const length = diag.getLength();

            let context: string | undefined;
            if (
              lineNumber !== undefined &&
              start !== undefined &&
              length !== undefined
            ) {
              const lines = sourceFile.getFullText().split("\n");
              const lineIndex = lineNumber - 1;

              // Get 3 lines of context (1 before, the error line, 1 after)
              const contextLines: string[] = [];
              const startLine = Math.max(0, lineIndex - 1);
              const endLine = Math.min(lines.length - 1, lineIndex + 1);

              for (let i = startLine; i <= endLine; i++) {
                const prefix = i === lineIndex ? "> " : "  ";
                contextLines.push(`${prefix}${i + 1} | ${lines[i]}`);
              }

              // Add error indicator
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
                : messageText.getMessageText
                ? messageText.getMessageText()
                : messageText.toString();

            return {
              message,
              severity: getDiagnosticSeverity(diag.getCategory()),
              location: {
                file: sourceFile.getFilePath(),
                position: {
                  line: lineNumber ? lineNumber - 1 : 0,
                  character: start
                    ? sourceFile.getLineAndColumnAtPos(start).column - 1
                    : 0,
                },
                endPosition:
                  start !== undefined && length !== undefined
                    ? {
                        line:
                          sourceFile.getLineAndColumnAtPos(start + length)
                            .line - 1,
                        character:
                          sourceFile.getLineAndColumnAtPos(start + length)
                            .column - 1,
                      }
                    : undefined,
              },
              code: diag.getCode()?.toString(),
              context,
            };
          });

          // Count by severity for this file
          const errorCount = diagnostics.filter(
            (d) => d.severity === "error"
          ).length;
          const warningCount = diagnostics.filter(
            (d) => d.severity === "warning"
          ).length;
          const infoCount = diagnostics.filter(
            (d) => d.severity === "info"
          ).length;

          totalErrors += errorCount;
          totalWarnings += warningCount;
          totalInfo += infoCount;

          allFileDiagnostics.push({
            file: filePath,
            diagnostics,
          });
        } catch (error) {
          console.error(`Error analyzing ${filePath}:`, error);
        }
      })
    )
  );

  // Sort files by number of errors (descending)
  allFileDiagnostics.sort((a, b) => {
    const aErrors = a.diagnostics.filter((d) => d.severity === "error").length;
    const bErrors = b.diagnostics.filter((d) => d.severity === "error").length;
    return bErrors - aErrors;
  });

  return {
    path: params.path,
    isDirectory,
    filesAnalyzed: filesToAnalyze.length,
    fileResults: allFileDiagnostics,
    summary: {
      totalErrors,
      totalWarnings,
      totalInfo,
      hasErrors: totalErrors > 0,
      fileCount: allFileDiagnostics.length,
      filesWithErrors: allFileDiagnostics.filter((f) =>
        f.diagnostics.some((d) => d.severity === "error")
      ).length,
    },
    analysisTimeMs: Date.now() - startTime,
  };
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
function calculateSearchScore(
  symbol: SymbolInfo,
  query: string,
  searchType: "text" | "semantic" | "ast-pattern"
): number {
  const lowerQuery = query.toLowerCase();
  const lowerName = symbol.name.toLowerCase();

  if (searchType === "text") {
    if (lowerName === lowerQuery) return 1.0;
    if (lowerName.startsWith(lowerQuery)) return 0.8;
    if (lowerName.includes(lowerQuery)) return 0.6;
    return 0;
  }

  if (searchType === "semantic") {
    let score = 0;
    if (lowerName.includes(lowerQuery)) score += 0.5;
    if (symbol.documentation?.toLowerCase().includes(lowerQuery)) score += 0.3;
    if (symbol.type.toLowerCase().includes(lowerQuery)) score += 0.2;
    return Math.min(score, 1.0);
  }

  return 0;
}

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

async function analyzeFileDependencies(
  sourceFile: SourceFile,
  nodes: any[],
  edges: any[],
  params: z.infer<typeof analyzeDependenciesSchema>
) {
  const filePath = sourceFile.getFilePath();
  const analysis = analyzeSourceFile(sourceFile, "all", 1, false);

  nodes.push({
    id: filePath,
    type: "file" as const,
    metrics: {
      imports: analysis.imports.length,
      exports: analysis.exports.length,
      complexity: analysis.complexity,
    },
  });

  if (params.direction === "imports" || params.direction === "both") {
    analysis.imports.forEach((imp) => {
      if (
        !params.includeNodeModules &&
        imp.moduleSpecifier.includes("node_modules")
      ) {
        return;
      }

      edges.push({
        from: filePath,
        to: imp.moduleSpecifier,
        type: "import" as const,
        symbols: imp.symbols,
      });
    });
  }
}

function getTextContext(
  text: string,
  position: number,
  lines: number = 3
): string {
  const lines_ = text.split("\n");
  const lineStarts = [0];

  for (let i = 0; i < lines_.length - 1; i++) {
    lineStarts.push(lineStarts[i] + lines_[i].length + 1);
  }

  let lineIndex = 0;
  for (let i = 0; i < lineStarts.length; i++) {
    if (position < lineStarts[i]) {
      lineIndex = i - 1;
      break;
    }
  }

  const startLine = Math.max(0, lineIndex - Math.floor(lines / 2));
  const endLine = Math.min(lines_.length, lineIndex + Math.ceil(lines / 2));

  return lines_.slice(startLine, endLine).join("\n");
}

function matchesAstPattern(node: Node, pattern: string): boolean {
  // Simple AST pattern matching
  // In a real implementation, this would use a proper AST pattern language

  if (pattern === "console.log") {
    return (
      Node.isCallExpression(node) &&
      node.getExpression().getText() === "console.log"
    );
  }

  if (pattern === "async-no-await") {
    return (
      Node.isFunctionDeclaration(node) &&
      node.hasModifier(SyntaxKind.AsyncKeyword) &&
      !node.getDescendantsOfKind(SyntaxKind.AwaitExpression).length
    );
  }

  if (pattern === "empty-catch") {
    return (
      Node.isCatchClause(node) && node.getBlock().getStatements().length === 0
    );
  }

  if (pattern === "typeof-comparison") {
    return (
      Node.isBinaryExpression(node) &&
      node.getLeft().getKind() === SyntaxKind.TypeOfExpression
    );
  }

  // Generic pattern matching by node kind
  try {
    const kindName = pattern.toUpperCase().replace(/-/g, "_");
    const syntaxKind = (SyntaxKind as any)[kindName];
    if (syntaxKind !== undefined) {
      return node.getKind() === syntaxKind;
    }
  } catch {}

  return false;
}

function matchesSemanticPattern(node: Node, pattern: string): boolean {
  // Semantic pattern matching based on code meaning

  if (pattern === "unused-import") {
    if (!Node.isImportDeclaration(node)) return false;
    // Would need to check if imported symbols are used
    return false; // Placeholder
  }

  if (pattern === "circular-dependency") {
    // Would need full project analysis
    return false; // Placeholder
  }

  if (pattern === "god-class") {
    if (!Node.isClassDeclaration(node)) return false;
    const methods = node.getMethods();
    const properties = node.getProperties();
    return methods.length > 20 || properties.length > 30;
  }

  if (pattern === "long-parameter-list") {
    if (
      !Node.isFunctionDeclaration(node) &&
      !Node.isMethodDeclaration(node) &&
      !Node.isArrowFunction(node)
    )
      return false;
    const params =
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isArrowFunction(node)
        ? node.getParameters()
        : [];
    return params.length > 5;
  }

  return false;
}

function detectComplexitySmells(
  sourceFile: SourceFile,
  smells: any[],
  threshold?: { complexity?: number; fileSize?: number; functionSize?: number }
) {
  const t = threshold || {};
  const complexityThreshold = t.complexity || 10;
  const functionSizeThreshold = t.functionSize || 50;
  const fileSizeThreshold = t.fileSize || 300;

  // Check file size
  const lines = sourceFile.getEndLineNumber();
  if (lines > fileSizeThreshold) {
    smells.push({
      type: "complexity" as CodeSmellCategory,
      severity: lines > fileSizeThreshold * 2 ? "high" : "medium",
      location: {
        file: sourceFile.getFilePath(),
        position: { line: 0, character: 0 },
      },
      message: `File has ${lines} lines, exceeding threshold of ${fileSizeThreshold}`,
      suggestion:
        "Consider splitting this file into smaller, more focused modules",
    });
  }

  // Check function complexity
  sourceFile.getFunctions().forEach((func) => {
    const complexity = getNodeComplexity(func);
    if (complexity > complexityThreshold) {
      smells.push({
        type: "complexity" as CodeSmellCategory,
        severity: complexity > complexityThreshold * 2 ? "high" : "medium",
        location: nodeToLocation(func),
        message: `Function has cyclomatic complexity of ${complexity}`,
        suggestion:
          "Consider breaking this function into smaller, more focused functions",
      });
    }

    const lines = func.getEndLineNumber() - func.getStartLineNumber();
    if (lines > functionSizeThreshold) {
      smells.push({
        type: "complexity" as CodeSmellCategory,
        severity: lines > functionSizeThreshold * 2 ? "high" : "medium",
        location: nodeToLocation(func),
        message: `Function has ${lines} lines, exceeding threshold of ${functionSizeThreshold}`,
        suggestion: "Consider breaking this function into smaller functions",
      });
    }
  });

  // Check class complexity
  sourceFile.getClasses().forEach((cls) => {
    const methods = cls.getMethods();
    const totalComplexity = methods.reduce(
      (sum, method) => sum + getNodeComplexity(method),
      0
    );

    if (totalComplexity > complexityThreshold * 3) {
      smells.push({
        type: "complexity" as CodeSmellCategory,
        severity: "high",
        location: nodeToLocation(cls),
        message: `Class has total complexity of ${totalComplexity}`,
        suggestion:
          "Consider splitting this class using Single Responsibility Principle",
      });
    }
  });
}

function detectNamingSmells(sourceFile: SourceFile, smells: any[]) {
  sourceFile.forEachDescendant((node) => {
    if (Node.isVariableDeclaration(node)) {
      const name = node.getName();

      // Single letter variables (except loop counters)
      if (name.length === 1 && !isLoopCounter(node)) {
        smells.push({
          type: "naming" as CodeSmellCategory,
          severity: "low",
          location: nodeToLocation(node),
          message: `Single letter variable name '${name}'`,
          suggestion: "Use descriptive variable names",
        });
      }

      // Non-descriptive names
      if (/^(temp|tmp|data|obj|arr|val|var|foo|bar|test)$/i.test(name)) {
        smells.push({
          type: "naming" as CodeSmellCategory,
          severity: "medium",
          location: nodeToLocation(node),
          message: `Non-descriptive variable name '${name}'`,
          suggestion:
            "Use meaningful names that describe the variable's purpose",
        });
      }
    }

    if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
      const name = node.getName();
      if (name) {
        // Functions should start with verb
        if (
          !/^(get|set|is|has|can|should|will|did|make|create|update|delete|remove|add|find|search|check|validate|process|handle|on)/.test(
            name
          )
        ) {
          smells.push({
            type: "naming" as CodeSmellCategory,
            severity: "low",
            location: nodeToLocation(node),
            message: `Function '${name}' doesn't start with a verb`,
            suggestion:
              "Function names should start with verbs to indicate action",
          });
        }
      }
    }

    if (Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node)) {
      const name = node.getName();
      if (name && !/^[A-Z]/.test(name)) {
        smells.push({
          type: "naming" as CodeSmellCategory,
          severity: "medium",
          location: nodeToLocation(node),
          message: `Type '${name}' doesn't start with uppercase letter`,
          suggestion: "Type names should use PascalCase",
        });
      }
    }
  });
}

function detectUnusedCode(sourceFile: SourceFile, smells: any[]) {
  // Check for unused variables
  sourceFile.getVariableDeclarations().forEach((varDecl) => {
    const identifier = varDecl.getNameNode();
    if (Node.isIdentifier(identifier)) {
      const refs = identifier.findReferences();
      let usageCount = 0;

      refs.forEach((ref) => {
        usageCount += ref.getReferences().length - 1; // Exclude declaration
      });

      if (usageCount === 0) {
        smells.push({
          type: "unused-code" as CodeSmellCategory,
          severity: "medium",
          location: nodeToLocation(varDecl),
          message: `Unused variable '${varDecl.getName()}'`,
          suggestion: "Remove unused variables to keep code clean",
        });
      }
    }
  });

  // Check for unused private methods in classes
  sourceFile.getClasses().forEach((cls) => {
    cls.getMethods().forEach((method) => {
      if (method.hasModifier(SyntaxKind.PrivateKeyword)) {
        const name = method.getName();
        if (name) {
          const identifier = method.getNameNode();
          if (identifier && Node.isIdentifier(identifier)) {
            const refs = identifier.findReferences();
            let usageCount = 0;

            refs.forEach((ref: any) => {
              usageCount += ref.getReferences().length - 1; // Exclude declaration
            });

            if (usageCount === 0) {
              smells.push({
                type: "unused-code" as CodeSmellCategory,
                severity: "medium",
                location: nodeToLocation(method),
                message: `Unused private method '${name}'`,
                suggestion: "Remove unused methods to reduce code complexity",
              });
            }
          }
        }
      }
    });
  });
}

function detectAsyncIssues(sourceFile: SourceFile, smells: any[]) {
  sourceFile.forEachDescendant((node) => {
    // Async function without await
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isArrowFunction(node)
    ) {
      if (node.hasModifier(SyntaxKind.AsyncKeyword)) {
        const awaits = node.getDescendantsOfKind(SyntaxKind.AwaitExpression);
        if (awaits.length === 0) {
          smells.push({
            type: "async-issues" as CodeSmellCategory,
            severity: "medium",
            location: nodeToLocation(node),
            message: "Async function without await",
            suggestion: "Remove async keyword if function doesn't use await",
          });
        }
      }
    }

    // Missing await on promise
    if (Node.isCallExpression(node)) {
      const type = node.getType();
      if (type.getSymbol()?.getName() === "Promise" && !isAwaited(node)) {
        const parent = node.getParent();
        if (
          !Node.isReturnStatement(parent) &&
          !Node.isAwaitExpression(parent)
        ) {
          smells.push({
            type: "async-issues" as CodeSmellCategory,
            severity: "high",
            location: nodeToLocation(node),
            message: "Promise not awaited",
            suggestion: "Add await keyword or handle promise properly",
          });
        }
      }
    }
  });
}

function detectCouplingIssues(sourceFile: SourceFile, smells: any[]) {
  // Check for high import count
  const imports = sourceFile.getImportDeclarations();
  if (imports.length > 15) {
    smells.push({
      type: "coupling" as CodeSmellCategory,
      severity: imports.length > 25 ? "high" : "medium",
      location: {
        file: sourceFile.getFilePath(),
        position: { line: 0, character: 0 },
      },
      message: `File has ${imports.length} imports`,
      suggestion:
        "High number of imports may indicate tight coupling. Consider refactoring.",
    });
  }

  // Check for classes with too many dependencies
  sourceFile.getClasses().forEach((cls) => {
    const constructor = cls.getConstructors()[0];
    if (constructor) {
      const params = constructor.getParameters();
      if (params.length > 5) {
        smells.push({
          type: "coupling" as CodeSmellCategory,
          severity: params.length > 8 ? "high" : "medium",
          location: nodeToLocation(constructor),
          message: `Constructor has ${params.length} parameters`,
          suggestion:
            "Consider using dependency injection container or builder pattern",
        });
      }
    }
  });
}

function isLoopCounter(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;

  const grandParent = parent.getParent();
  return (
    grandParent !== null &&
    (Node.isForStatement(grandParent) ||
      Node.isForInStatement(grandParent) ||
      Node.isForOfStatement(grandParent))
  );
}

function isAwaited(node: Node): boolean {
  let current = node.getParent();
  while (current) {
    if (Node.isAwaitExpression(current)) return true;
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isMethodDeclaration(current) ||
      Node.isArrowFunction(current)
    )
      return false;
    current = current.getParent();
  }
  return false;
}

function extractFunctionContext(
  node: Node,
  includeTypes: boolean = true
): string {
  let context = "";

  // Find the enclosing function
  let funcNode = node;
  while (
    funcNode &&
    !Node.isFunctionDeclaration(funcNode) &&
    !Node.isMethodDeclaration(funcNode) &&
    !Node.isArrowFunction(funcNode)
  ) {
    funcNode = funcNode.getParent() || funcNode;
  }

  if (
    Node.isFunctionDeclaration(funcNode) ||
    Node.isMethodDeclaration(funcNode) ||
    Node.isArrowFunction(funcNode)
  ) {
    // Include JSDoc comments
    const docs = funcNode.getJsDocs();
    if (docs.length > 0) {
      context += docs.map((doc) => doc.getText()).join("\n") + "\n";
    }

    // Include the function signature and body
    context += funcNode.getText();

    if (includeTypes) {
      // Include parameter types
      const params = funcNode.getParameters();
      if (params.length > 0) {
        context += "\n\n// Parameter types:\n";
        params.forEach((param) => {
          const type = param.getType();
          context += `// ${param.getName()}: ${getTypeString(type)}\n`;
        });
      }

      // Include return type
      const returnType = funcNode.getReturnType();
      context += `// Returns: ${getTypeString(returnType)}\n`;
    }
  }

  return context;
}

function extractClassContext(node: Node, includeTypes: boolean = true): string {
  let context = "";

  // Find the enclosing class
  let classNode = node;
  while (classNode && !Node.isClassDeclaration(classNode)) {
    classNode = classNode.getParent() || classNode;
  }

  if (Node.isClassDeclaration(classNode)) {
    // Include JSDoc comments
    const docs = classNode.getJsDocs();
    if (docs.length > 0) {
      context += docs.map((doc) => doc.getText()).join("\n") + "\n";
    }

    // Include class declaration with inheritance
    const heritage = classNode.getHeritageClauses();
    let declaration = `class ${classNode.getName() || "Anonymous"}`;

    heritage.forEach((clause) => {
      declaration += ` ${clause.getText()}`;
    });

    context += declaration + " {\n";

    // Include constructor
    const constructors = classNode.getConstructors();
    constructors.forEach((ctor) => {
      context += "  " + ctor.getText().split("\n").join("\n  ") + "\n\n";
    });

    // Include properties
    const properties = classNode.getProperties();
    properties.forEach((prop) => {
      context += "  " + prop.getText() + "\n";
    });

    if (properties.length > 0) context += "\n";

    // Include methods (signatures only for brevity)
    const methods = classNode.getMethods();
    methods.forEach((method) => {
      const modifiers = method
        .getModifiers()
        .map((m) => m.getText())
        .join(" ");
      const params = method
        .getParameters()
        .map((p) => p.getName())
        .join(", ");
      context += `  ${modifiers} ${method.getName()}(${params}): ${getTypeString(
        method.getReturnType()
      )}\n`;
    });

    context += "}";

    if (includeTypes) {
      // Include member information
      const members = extractMembers(classNode);
      if (members.length > 0) {
        context += "\n\n// Members:\n";
        members.forEach((member) => {
          context += `// ${member.visibility} ${
            member.static ? "static " : ""
          }${member.name}: ${member.type}\n`;
        });
      }
    }
  }

  return context;
}

function extractModuleContext(
  sourceFile: SourceFile,
  includeTypes: boolean = true
): string {
  let context = "";

  // Include file-level JSDoc comments
  const leadingComments = sourceFile.getLeadingCommentRanges();
  if (leadingComments.length > 0) {
    context +=
      leadingComments
        .map((comment) =>
          sourceFile.getFullText().substring(comment.getPos(), comment.getEnd())
        )
        .join("\n") + "\n\n";
  }

  // Include imports
  const imports = sourceFile.getImportDeclarations();
  if (imports.length > 0) {
    context += "// Imports:\n";
    imports.forEach((imp) => {
      context += imp.getText() + "\n";
    });
    context += "\n";
  }

  // Include exports
  const exports = sourceFile.getExportDeclarations();
  const exportedDecls = sourceFile.getExportedDeclarations();

  if (exports.length > 0 || exportedDecls.size > 0) {
    context += "// Exports:\n";
    exports.forEach((exp) => {
      context += exp.getText() + "\n";
    });

    exportedDecls.forEach((decls, name) => {
      decls.forEach((decl) => {
        if (Node.isFunctionDeclaration(decl) || Node.isClassDeclaration(decl)) {
          const signature = decl.getName() || "anonymous";
          context += `export ${decl
            .getKindName()
            .toLowerCase()} ${signature}\n`;
        }
      });
    });
    context += "\n";
  }

  // Include main declarations
  const classes = sourceFile.getClasses();
  const functions = sourceFile.getFunctions();
  const interfaces = sourceFile.getInterfaces();
  const typeAliases = sourceFile.getTypeAliases();

  if (classes.length > 0) {
    context += "// Classes:\n";
    classes.forEach((cls) => {
      context += `class ${cls.getName() || "Anonymous"}\n`;
    });
    context += "\n";
  }

  if (functions.length > 0) {
    context += "// Functions:\n";
    functions.forEach((func) => {
      const params = func
        .getParameters()
        .map((p) => p.getName())
        .join(", ");
      context += `function ${func.getName()}(${params})\n`;
    });
    context += "\n";
  }

  if (includeTypes && (interfaces.length > 0 || typeAliases.length > 0)) {
    context += "// Types:\n";
    interfaces.forEach((iface) => {
      context += `interface ${iface.getName()}\n`;
    });
    typeAliases.forEach((alias) => {
      context += `type ${alias.getName()}\n`;
    });
  }

  return context;
}

function extractRelatedContext(
  node: Node,
  project: Project,
  followReferences: boolean = false
): string {
  let context = "";

  // Get the symbol and its information
  const symbol = node.getSymbol();
  if (!symbol) return context;

  const symbolInfo = extractSymbolInfo(node, true);
  if (!symbolInfo) return context;

  // Include the symbol definition
  context += `// ${symbolInfo.kind}: ${symbolInfo.name}\n`;
  context += node.getText() + "\n\n";

  // Include related types
  if (symbolInfo.relationships) {
    if (
      symbolInfo.relationships.extends &&
      symbolInfo.relationships.extends.length > 0
    ) {
      context += "// Extends:\n";
      symbolInfo.relationships.extends.forEach((ext) => {
        context += `// - ${ext.name}\n`;
      });
      context += "\n";
    }

    if (
      symbolInfo.relationships.implements &&
      symbolInfo.relationships.implements.length > 0
    ) {
      context += "// Implements:\n";
      symbolInfo.relationships.implements.forEach((impl) => {
        context += `// - ${impl.name}\n`;
      });
      context += "\n";
    }
  }

  if (followReferences && Node.isIdentifier(node)) {
    // Find and include references
    const refs = node.findReferences();
    const locations = new Set<string>();

    refs.forEach((ref) => {
      ref.getReferences().forEach((refEntry) => {
        const refNode = refEntry.getNode();
        const file = refNode.getSourceFile().getFilePath();
        const line = refNode.getStartLineNumber();
        locations.add(`${file}:${line}`);
      });
    });

    if (locations.size > 0) {
      context += "// Referenced in:\n";
      Array.from(locations)
        .slice(0, 10)
        .forEach((loc) => {
          context += `// - ${loc}\n`;
        });
      if (locations.size > 10) {
        context += `// ... and ${locations.size - 10} more locations\n`;
      }
    }
  }

  return context;
}

function detectArchitecturalLayers(files: string[]): Layer[] {
  const layers: Layer[] = [];
  const layerPatterns = [
    {
      name: "presentation",
      patterns: ["/views/", "/components/", "/pages/", "/ui/"],
    },
    {
      name: "application",
      patterns: ["/controllers/", "/handlers/", "/routes/"],
    },
    { name: "business", patterns: ["/services/", "/usecases/", "/domain/"] },
    {
      name: "data",
      patterns: ["/repositories/", "/models/", "/entities/", "/db/"],
    },
    {
      name: "infrastructure",
      patterns: ["/config/", "/utils/", "/helpers/", "/lib/"],
    },
  ];

  layerPatterns.forEach((layer) => {
    const moduleFiles = files.filter((file) =>
      layer.patterns.some((pattern) => file.includes(pattern))
    );

    if (moduleFiles.length > 0) {
      layers.push({
        name: layer.name,
        modules: moduleFiles
          .slice(0, 10)
          .map((f) => path.basename(f, path.extname(f))),
        dependsOn: [], // Would need deeper analysis to determine dependencies
      });
    }
  });

  return layers;
}
