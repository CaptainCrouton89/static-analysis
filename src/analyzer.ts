import { 
  Project, 
  SourceFile, 
  Node, 
  Symbol,
  Type,
  SyntaxKind,
  ts,
  ClassDeclaration,
  InterfaceDeclaration,
  FunctionDeclaration,
  VariableDeclaration,
  TypeAliasDeclaration,
  EnumDeclaration
} from "ts-morph";
import path from "path";
import { 
  SymbolInfo, 
  SymbolReference,
  Diagnostic,
  ImportInfo,
  TypeDefinition,
  Location,
  MemberInfo,
  TypeInfo
} from "./types.js";
import { 
  nodeToLocation, 
  getSymbolKind, 
  getTypeString,
  positionToOffset,
  getNodeComplexity
} from "./utils.js";

export function extractSymbolInfo(node: Node, includePrivate: boolean = false): SymbolInfo | null {
  const symbol = node.getSymbol();
  if (!symbol) return null;
  
  const name = symbol.getName();
  if (!includePrivate && name.startsWith("_")) return null;
  
  const kind = getSymbolKind(node);
  const type = node.getType();
  
  const modifiers: string[] = [];
  if (Node.isModifierable(node)) {
    if (node.hasModifier(SyntaxKind.PublicKeyword)) modifiers.push("public");
    if (node.hasModifier(SyntaxKind.PrivateKeyword)) modifiers.push("private");
    if (node.hasModifier(SyntaxKind.ProtectedKeyword)) modifiers.push("protected");
    if (node.hasModifier(SyntaxKind.StaticKeyword)) modifiers.push("static");
    if (node.hasModifier(SyntaxKind.AsyncKeyword)) modifiers.push("async");
    if (node.hasModifier(SyntaxKind.ReadonlyKeyword)) modifiers.push("readonly");
    if (node.hasModifier(SyntaxKind.AbstractKeyword)) modifiers.push("abstract");
  }
  
  const documentation = symbol.getJsDocTags().map(tag => 
    `@${tag.getName()}${tag.getText() ? ` ${tag.getText()}` : ""}`
  ).join("\n");
  
  return {
    name,
    kind,
    type: getTypeString(type),
    documentation: documentation || undefined,
    modifiers: modifiers.length > 0 ? modifiers : undefined,
    location: nodeToLocation(node),
    relationships: extractRelationships(node)
  };
}

function extractRelationships(node: Node): SymbolInfo["relationships"] | undefined {
  const relationships: SymbolInfo["relationships"] = {};
  
  if (Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node)) {
    const heritage = node.getHeritageClauses();
    const extendsClause = heritage.find(h => h.getToken() === SyntaxKind.ExtendsKeyword);
    if (extendsClause) {
      const extendsNodes = extendsClause.getTypeNodes();
      if (extendsNodes.length > 0) {
        relationships.extends = extendsNodes.map(expr => ({
          name: expr.getText(),
          location: nodeToLocation(expr),
          kind: "class" as const
        }));
      }
    }
    
    if (Node.isClassDeclaration(node)) {
      const implementsNodes = node.getImplements() || [];
      if (implementsNodes.length > 0) {
        relationships.implements = implementsNodes.map(expr => ({
          name: expr.getText(),
          location: nodeToLocation(expr),
          kind: "interface" as const
        }));
      }
    }
  }
  
  return Object.keys(relationships).length > 0 ? relationships : undefined;
}

export function analyzeSourceFile(
  sourceFile: SourceFile,
  analysisType: "symbols" | "dependencies" | "complexity" | "all",
  depth: number = 2,
  includePrivate: boolean = false
): {
  symbols: SymbolInfo[];
  diagnostics: Diagnostic[];
  imports: ImportInfo[];
  exports: string[];
  complexity: number;
} {
  const symbols: SymbolInfo[] = [];
  const imports: ImportInfo[] = [];
  const exports: string[] = [];
  let totalComplexity = 0;
  
  if (analysisType === "symbols" || analysisType === "all") {
    sourceFile.forEachDescendant(node => {
      if (isDeclarationNode(node)) {
        const symbolInfo = extractSymbolInfo(node, includePrivate);
        if (symbolInfo) {
          symbols.push(symbolInfo);
        }
      }
    });
  }
  
  if (analysisType === "dependencies" || analysisType === "all") {
    sourceFile.getImportDeclarations().forEach(importDecl => {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      const namedImports = importDecl.getNamedImports().map(ni => ni.getName());
      const defaultImport = importDecl.getDefaultImport()?.getText();
      const namespaceImport = importDecl.getNamespaceImport()?.getText();
      
      const allImports = [
        ...(defaultImport ? [defaultImport] : []),
        ...(namespaceImport ? [namespaceImport] : []),
        ...namedImports
      ];
      
      if (allImports.length > 0) {
        imports.push({
          moduleSpecifier,
          symbols: allImports,
          isTypeOnly: importDecl.isTypeOnly(),
          location: nodeToLocation(importDecl)
        });
      }
    });
    
    sourceFile.getExportDeclarations().forEach(exportDecl => {
      const namedExports = exportDecl.getNamedExports().map(ne => ne.getName());
      exports.push(...namedExports);
    });
    
    sourceFile.getExportedDeclarations().forEach((declarations, name) => {
      exports.push(name);
    });
  }
  
  if (analysisType === "complexity" || analysisType === "all") {
    sourceFile.getFunctions().forEach(func => {
      totalComplexity += getNodeComplexity(func);
    });
    
    sourceFile.getClasses().forEach(cls => {
      cls.getMethods().forEach(method => {
        totalComplexity += getNodeComplexity(method);
      });
    });
  }
  
  const diagnostics = sourceFile.getPreEmitDiagnostics().map(diag => ({
    message: diag.getMessageText().toString(),
    severity: getDiagnosticSeverity(diag.getCategory()),
    location: {
      file: sourceFile.getFilePath(),
      position: {
        line: diag.getLineNumber() ? diag.getLineNumber()! - 1 : 0,
        character: diag.getStart() ? sourceFile.getLineAndColumnAtPos(diag.getStart()!).column - 1 : 0
      }
    },
    code: diag.getCode()?.toString()
  }));
  
  return {
    symbols,
    diagnostics,
    imports,
    exports,
    complexity: totalComplexity
  };
}

function isDeclarationNode(node: Node): boolean {
  return Node.isClassDeclaration(node) ||
         Node.isInterfaceDeclaration(node) ||
         Node.isFunctionDeclaration(node) ||
         Node.isVariableDeclaration(node) ||
         Node.isTypeAliasDeclaration(node) ||
         Node.isEnumDeclaration(node) ||
         Node.isMethodDeclaration(node) ||
         Node.isPropertyDeclaration(node) ||
         Node.isGetAccessorDeclaration(node) ||
         Node.isSetAccessorDeclaration(node);
}

function getDiagnosticSeverity(category: ts.DiagnosticCategory): "error" | "warning" | "info" {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    default:
      return "info";
  }
}

export function findSymbolAtPosition(
  sourceFile: SourceFile,
  position: { line: number; character: number }
): Node | undefined {
  const offset = positionToOffset(sourceFile, position);
  return sourceFile.getDescendantAtPos(offset);
}

export function getTypeHierarchy(
  node: Node,
  direction: "ancestors" | "descendants" | "both",
  maxDepth: number = 5
): TypeInfo[] {
  const hierarchy: TypeInfo[] = [];
  const visited = new Set<string>();
  
  function processType(type: Type, depth: number) {
    if (depth > maxDepth) return;
    
    const symbol = type.getSymbol();
    if (!symbol) return;
    
    const name = symbol.getName();
    if (visited.has(name)) return;
    visited.add(name);
    
    const declarations = symbol.getDeclarations();
    if (declarations.length === 0) return;
    
    const declaration = declarations[0];
    const typeInfo: TypeInfo = {
      name,
      kind: getTypeKind(declaration),
      location: nodeToLocation(declaration),
      generics: getGenericParameters(declaration)
    };
    
    hierarchy.push(typeInfo);
    
    if (direction === "ancestors" || direction === "both") {
      const baseTypes = type.getBaseTypes();
      baseTypes.forEach(baseType => processType(baseType, depth + 1));
    }
    
    if (direction === "descendants" || direction === "both") {
      // Finding descendants requires project-wide analysis
      // This would need to be implemented by searching all files
    }
  }
  
  const type = node.getType();
  processType(type, 0);
  
  return hierarchy;
}

function getTypeKind(node: Node): "class" | "interface" | "enum" | "type" {
  if (Node.isClassDeclaration(node)) return "class";
  if (Node.isInterfaceDeclaration(node)) return "interface";
  if (Node.isEnumDeclaration(node)) return "enum";
  return "type";
}

function getGenericParameters(node: Node): string[] | undefined {
  if (!Node.isTypeParametered(node)) return undefined;
  
  const params = node.getTypeParameters();
  if (params.length === 0) return undefined;
  
  return params.map(p => p.getName());
}

export function extractMembers(node: Node): MemberInfo[] {
  const members: MemberInfo[] = [];
  
  if (Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node)) {
    const type = node.getType();
    const properties = type.getProperties();
    
    properties.forEach(prop => {
      const propDecl = prop.getValueDeclaration();
      if (!propDecl) return;
      
      let kind: MemberInfo["kind"] = "property";
      let visibility: MemberInfo["visibility"] = "public";
      let isStatic = false;
      
      if (Node.isMethodDeclaration(propDecl)) {
        kind = "method";
      } else if (Node.isGetAccessorDeclaration(propDecl)) {
        kind = "getter";
      } else if (Node.isSetAccessorDeclaration(propDecl)) {
        kind = "setter";
      }
      
      if (Node.isModifierable(propDecl)) {
        if (propDecl.hasModifier(SyntaxKind.PrivateKeyword)) visibility = "private";
        else if (propDecl.hasModifier(SyntaxKind.ProtectedKeyword)) visibility = "protected";
        isStatic = propDecl.hasModifier(SyntaxKind.StaticKeyword);
      }
      
      members.push({
        name: prop.getName(),
        kind,
        visibility,
        type: getTypeString(prop.getTypeAtLocation(propDecl)),
        static: isStatic
      });
    });
  }
  
  return members;
}