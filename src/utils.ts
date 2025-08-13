import { Project, SourceFile, Node, SyntaxKind, Symbol, Type, ts } from "ts-morph";
import { glob } from "glob";
import { minimatch } from "minimatch";
import path from "path";
import * as fs from "fs";
import { 
  Position, 
  Location, 
  SymbolKind, 
  PerformanceConfig,
  ErrorCode,
  AnalysisError
} from "./types.js";
import { cacheManager } from "./cache.js";

// Re-export for backward compatibility
export const fileCache = {
  get: (key: string) => {
    const cached = cacheManager.getCachedFile(key);
    return cached?.then(c => c?.sourceFile);
  },
  set: (key: string, value: SourceFile) => {
    cacheManager.setCachedFile(key, value);
  },
  clear: () => cacheManager.clearFileCache()
};

export const symbolCache = {
  get: (key: string) => cacheManager.getCachedSymbol(key),
  set: (key: string, value: any) => cacheManager.setCachedSymbol(key, value),
  clear: () => cacheManager.clearSymbolCache()
};

export const performanceConfig: PerformanceConfig = {
  maxMemoryMB: 2048,
  batchSize: 50,
  cacheStrategy: "memory",
  gcInterval: 100
};

export const timeoutLimits = {
  singleFile: 5000,
  symbolSearch: 10000,
  projectAnalysis: 60000,
  impactAnalysis: 30000,
};

export const securityConfig = {
  allowedPaths: ["./src", "./tests", "./lib"],
  excludePatterns: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
  maxFileSize: 5 * 1024 * 1024,
  maxPathDepth: 10,
};

export function findProjectRoot(filePath: string): string {
  let currentDir = path.dirname(path.resolve(filePath));
  
  // First priority: look for tsconfig.json (closest to the file)
  let tsConfigDir: string | null = null;
  let tempDir = currentDir;
  while (tempDir !== path.dirname(tempDir)) {
    if (fs.existsSync(path.join(tempDir, 'tsconfig.json'))) {
      tsConfigDir = tempDir;
      break;
    }
    tempDir = path.dirname(tempDir);
  }
  
  // If we found a tsconfig.json, use it
  if (tsConfigDir) {
    return tsConfigDir;
  }
  
  // Fallback: look for package.json or .git
  while (currentDir !== path.dirname(currentDir)) {
    if (fs.existsSync(path.join(currentDir, 'package.json')) ||
        fs.existsSync(path.join(currentDir, '.git'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  
  // Final fallback to the directory containing the file
  return path.dirname(path.resolve(filePath));
}

export function createProject(rootPath?: string, includeNodeModules: boolean = false): Project {
  const workingDir = rootPath || process.cwd();
  const tsConfigPath = path.join(workingDir, "tsconfig.json");
  
  // Check if tsconfig.json exists, if not create project without it
  const tsConfigExists = fs.existsSync(tsConfigPath);
  
  const baseOptions: any = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    declaration: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    strict: false, // Disable strict mode for better compatibility
    skipLibCheck: true,
    noEmit: true,
    resolveJsonModule: true,
    isolatedModules: true,
    allowImportingTsExtensions: false,
    noResolve: false
  };

  if (includeNodeModules) {
    baseOptions.typeRoots = [
      path.join(workingDir, "node_modules/@types"),
      path.join(workingDir, "node_modules")
    ];
    baseOptions.baseUrl = workingDir;
    baseOptions.paths = {
      "*": ["node_modules/*", "node_modules/@types/*"]
    };
  }

  const project = new Project({
    ...(tsConfigExists && !includeNodeModules && { tsConfigFilePath: tsConfigPath }),
    skipAddingFilesFromTsConfig: true,
    compilerOptions: baseOptions,
    useInMemoryFileSystem: false,
    skipFileDependencyResolution: false
  });
  
  return project;
}

export function findClosestTsConfig(filePath: string): string | null {
  let currentDir = path.dirname(path.resolve(filePath));
  
  // Walk up from the target path looking only for tsconfig.json
  while (currentDir !== path.dirname(currentDir)) {
    const tsConfigPath = path.join(currentDir, 'tsconfig.json');
    if (fs.existsSync(tsConfigPath)) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  
  return null;
}

export function nodeToLocation(node: Node): Location {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndColumnAtPos(node.getStart());
  const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
  
  return {
    file: sourceFile.getFilePath(),
    position: {
      line: start.line - 1,
      character: start.column - 1
    },
    endPosition: {
      line: end.line - 1,
      character: end.column - 1
    }
  };
}

export function positionToOffset(sourceFile: SourceFile, position: Position): number {
  const character = position.character ?? 0;
  const pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(position.line, character);
  return pos;
}

export function getSymbolKind(node: Node): SymbolKind {
  const kind = node.getKind();
  
  switch (kind) {
    case SyntaxKind.ClassDeclaration:
      return "class";
    case SyntaxKind.InterfaceDeclaration:
      return "interface";
    case SyntaxKind.EnumDeclaration:
      return "enum";
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return "function";
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
      return "method";
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
      return "property";
    case SyntaxKind.VariableDeclaration:
      return "variable";
    case SyntaxKind.Parameter:
      return "parameter";
    case SyntaxKind.TypeAliasDeclaration:
      return "type";
    case SyntaxKind.ModuleDeclaration:
      return "module";
    case SyntaxKind.NamespaceKeyword:
      return "namespace";
    default:
      return "variable";
  }
}

export async function findFiles(
  pattern: string,
  basePath: string = process.cwd()
): Promise<string[]> {
  const files = await glob(pattern, {
    cwd: basePath,
    absolute: true,
    ignore: securityConfig.excludePatterns,
  });
  
  return files.filter(file => {
    const relativePath = path.relative(basePath, file);
    const depth = relativePath.split(path.sep).length;
    return depth <= securityConfig.maxPathDepth;
  });
}

export function matchesScope(filePath: string, scope?: {
  includeFiles?: string[];
  excludeFiles?: string[];
  fileTypes?: string[];
}): boolean {
  if (!scope) return true;
  
  if (scope.fileTypes) {
    const ext = path.extname(filePath);
    if (!scope.fileTypes.includes(ext)) return false;
  }
  
  if (scope.excludeFiles) {
    for (const pattern of scope.excludeFiles) {
      if (minimatch(filePath, pattern)) return false;
    }
  }
  
  if (scope.includeFiles) {
    for (const pattern of scope.includeFiles) {
      if (minimatch(filePath, pattern)) return true;
    }
    return false;
  }
  
  return true;
}

export function validatePath(filePath: string, allowNodeModules: boolean = false): void {
  const normalizedPath = path.normalize(filePath);
  const relativePath = path.relative(process.cwd(), normalizedPath);
  
  if (relativePath.startsWith('..')) {
    throw new AnalysisError({
      code: ErrorCode.SCOPE_ERROR,
      message: "Path is outside allowed scope",
      details: { file: filePath }
    });
  }
  
  for (const pattern of securityConfig.excludePatterns) {
    // Skip node_modules exclusion if allowNodeModules is true
    if (allowNodeModules && pattern.includes('node_modules')) {
      continue;
    }
    
    if (minimatch(normalizedPath, pattern)) {
      throw new AnalysisError({
        code: ErrorCode.SCOPE_ERROR,
        message: "Path matches excluded pattern",
        details: { file: filePath }
      });
    }
  }
}

export function getNodeComplexity(node: Node): number {
  let complexity = 1;
  
  node.forEachDescendant(child => {
    const kind = child.getKind();
    if (
      kind === SyntaxKind.IfStatement ||
      kind === SyntaxKind.ForStatement ||
      kind === SyntaxKind.ForInStatement ||
      kind === SyntaxKind.ForOfStatement ||
      kind === SyntaxKind.WhileStatement ||
      kind === SyntaxKind.DoStatement ||
      kind === SyntaxKind.ConditionalExpression ||
      kind === SyntaxKind.CatchClause ||
      kind === SyntaxKind.CaseClause ||
      kind === SyntaxKind.BinaryExpression
    ) {
      complexity++;
    }
  });
  
  return complexity;
}

export function getTypeString(type: Type): string {
  const typeText = type.getText();
  if (typeText.length > 100) {
    return typeText.substring(0, 97) + "...";
  }
  return typeText;
}

export async function checkMemoryUsage(): Promise<void> {
  const usage = process.memoryUsage();
  const heapUsedMB = usage.heapUsed / 1024 / 1024;
  const cacheMemoryMB = cacheManager.getMemoryUsage() / 1024 / 1024;
  
  if (heapUsedMB + cacheMemoryMB > performanceConfig.maxMemoryMB * 0.9) {
    if (global.gc) {
      global.gc();
    }
    await cacheManager.clearAll();
  }
}

export class TimeoutError extends Error {
  constructor(operation: string, limit: number) {
    super(`Operation '${operation}' timed out after ${limit}ms`);
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  operation: string,
  limit: number
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new TimeoutError(operation, limit)), limit)
    )
  ]);
}