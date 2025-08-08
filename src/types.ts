export interface Position {
  line: number;
  character?: number;
}

export interface SymbolIdentifier {
  filePath: string;
  symbolName: string;
  line: number;
}

export interface Location {
  file: string;
  position: Position;
  endPosition?: Position;
}

export type SymbolKind = 
  | "class"
  | "interface"
  | "enum"
  | "function"
  | "method"
  | "property"
  | "variable"
  | "parameter"
  | "type"
  | "namespace"
  | "module";

export interface SymbolReference {
  name: string;
  kind: SymbolKind;
}

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  type: string;
  location: {
    file: string;
    line: number;
  };
  documentation?: string;
  modifiers?: string[];
  relationships?: {
    extends?: SymbolReference[];
    implements?: SymbolReference[];
    usedBy?: SymbolReference[];
    uses?: SymbolReference[];
  };
}

export interface Diagnostic {
  message: string;
  severity: "error" | "warning" | "info";
  code?: string;
}

export interface ScopeOptions {
  includeFiles?: string[];
  excludeFiles?: string[];
  fileTypes?: string[];
}

export interface ImportInfo {
  moduleSpecifier: string;
  symbols: string[];
  isTypeOnly: boolean;
}

export interface TypeDefinition {
  name: string;
  kind: string;
  definition: string;
  location: Location;
}

export interface MemberInfo {
  name: string;
  kind: "method" | "property" | "getter" | "setter";
  visibility: "public" | "private" | "protected";
  type: string;
  static: boolean;
}

export interface TypeInfo {
  name: string;
  kind: "class" | "interface" | "enum" | "type";
  location: Location;
  generics?: string[];
}

export interface Layer {
  name: string;
  modules: string[];
  dependsOn: string[];
}

export interface DependencyMatrix {
  [from: string]: {
    [to: string]: number;
  };
}

export interface CodeAction {
  description: string;
  edits: Array<{
    file: string;
    changes: Array<{
      location: Location;
      newText: string;
    }>;
  }>;
}

export enum ErrorCode {
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  PARSE_ERROR = "PARSE_ERROR",
  TIMEOUT = "TIMEOUT",
  MEMORY_LIMIT = "MEMORY_LIMIT",
  INVALID_PATTERN = "INVALID_PATTERN",
  SCOPE_ERROR = "SCOPE_ERROR",
}

export type CodeSmellCategory =
  | "complexity"
  | "duplication"
  | "coupling"
  | "naming"
  | "unused-code"
  | "async-issues";

export class AnalysisError extends Error {
  code: ErrorCode;
  details?: {
    file?: string;
    position?: Position;
    suggestion?: string;
    symbolName?: string;
    line?: number;
    expected?: string;
    found?: string;
  };

  constructor(data: {
    code: ErrorCode;
    message: string;
    details?: {
      file?: string;
      position?: Position;
      suggestion?: string;
      symbolName?: string;
      line?: number;
      expected?: string;
      found?: string;
    };
  }) {
    super(data.message);
    this.code = data.code;
    this.details = data.details;
    this.name = "AnalysisError";
  }
}

export interface PerformanceConfig {
  maxMemoryMB: number;
  batchSize: number;
  cacheStrategy: "memory" | "disk" | "hybrid";
  gcInterval: number;
}