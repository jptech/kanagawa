//! Symbol table for name resolution.
//!
//! The symbol table maps names to definitions and tracks lexical scopes
//! for proper name resolution.

use crate::def::{DefId, DefIdGenerator, DefKind, Definition, Visibility};
use crate::ty::Ty;
use crate::Span;
use std::collections::HashMap;

/// Unique identifier for a scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ScopeId(pub u32);

impl ScopeId {
    /// The root/global scope.
    pub const ROOT: ScopeId = ScopeId(0);
}

/// Kind of scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeKind {
    /// Global/file scope.
    Global,
    /// Module scope.
    Module,
    /// Function scope.
    Function,
    /// Block scope.
    Block,
    /// Class scope.
    Class,
    /// Struct scope.
    Struct,
    /// Enum scope.
    Enum,
    /// Union scope.
    Union,
    /// Template scope.
    Template,
}

/// A lexical scope.
#[derive(Debug, Clone)]
pub struct Scope {
    /// Unique identifier.
    pub id: ScopeId,
    /// Kind of scope.
    pub kind: ScopeKind,
    /// Parent scope (None for global scope).
    pub parent: Option<ScopeId>,
    /// Symbols defined in this scope (name -> DefId).
    pub symbols: HashMap<String, DefId>,
    /// Associated DefId (for named scopes like functions, classes).
    pub def_id: Option<DefId>,
    /// Qualified name prefix for this scope.
    pub qualified_prefix: Vec<String>,
}

impl Scope {
    /// Create a new scope.
    pub fn new(id: ScopeId, kind: ScopeKind, parent: Option<ScopeId>) -> Self {
        Self {
            id,
            kind,
            parent,
            symbols: HashMap::new(),
            def_id: None,
            qualified_prefix: Vec::new(),
        }
    }

    /// Insert a symbol into this scope.
    pub fn insert(&mut self, name: impl Into<String>, def_id: DefId) {
        self.symbols.insert(name.into(), def_id);
    }

    /// Look up a symbol in this scope only (not parents).
    pub fn get(&self, name: &str) -> Option<DefId> {
        self.symbols.get(name).copied()
    }
}

/// Symbol entry with type information.
#[derive(Debug, Clone)]
pub struct SymbolEntry {
    /// The definition.
    pub def: Definition,
    /// The type of this symbol (for expressions, variables, etc.).
    pub ty: Ty,
}

/// The symbol table.
#[derive(Debug)]
pub struct SymbolTable {
    /// All definitions indexed by DefId.
    definitions: Vec<SymbolEntry>,
    /// All scopes indexed by ScopeId.
    scopes: Vec<Scope>,
    /// DefId generator.
    def_id_gen: DefIdGenerator,
    /// Scope ID generator counter.
    next_scope_id: u32,
    /// Current scope during resolution.
    current_scope: ScopeId,
    /// Map from qualified names to DefIds for fast lookup.
    qualified_names: HashMap<Vec<String>, DefId>,
}

impl SymbolTable {
    /// Create a new symbol table.
    pub fn new() -> Self {
        let mut table = Self {
            definitions: Vec::new(),
            scopes: Vec::new(),
            def_id_gen: DefIdGenerator::new(),
            next_scope_id: 0,
            current_scope: ScopeId::ROOT,
            qualified_names: HashMap::new(),
        };
        // Create the root/global scope
        table.scopes.push(Scope::new(ScopeId::ROOT, ScopeKind::Global, None));
        table.next_scope_id = 1;
        table
    }

    /// Get the current scope ID.
    pub fn current_scope(&self) -> ScopeId {
        self.current_scope
    }

    /// Get a scope by ID.
    pub fn scope(&self, id: ScopeId) -> Option<&Scope> {
        self.scopes.get(id.0 as usize)
    }

    /// Get a mutable scope by ID.
    pub fn scope_mut(&mut self, id: ScopeId) -> Option<&mut Scope> {
        self.scopes.get_mut(id.0 as usize)
    }

    /// Get the current scope.
    pub fn current_scope_ref(&self) -> &Scope {
        self.scope(self.current_scope).expect("current scope exists")
    }

    /// Push a new scope and return its ID.
    pub fn push_scope(&mut self, kind: ScopeKind) -> ScopeId {
        let id = ScopeId(self.next_scope_id);
        self.next_scope_id += 1;

        let parent = Some(self.current_scope);
        let mut scope = Scope::new(id, kind, parent);

        // Inherit qualified prefix from parent
        if let Some(parent_scope) = self.scope(self.current_scope) {
            scope.qualified_prefix = parent_scope.qualified_prefix.clone();
        }

        self.scopes.push(scope);
        self.current_scope = id;
        id
    }

    /// Pop the current scope and return to parent.
    pub fn pop_scope(&mut self) {
        if let Some(scope) = self.scope(self.current_scope) {
            if let Some(parent) = scope.parent {
                self.current_scope = parent;
            }
        }
    }

    /// Define a new symbol in the current scope.
    pub fn define(
        &mut self,
        name: impl Into<String>,
        kind: DefKind,
        ty: Ty,
        span: Span,
    ) -> DefId {
        self.define_with_visibility(name, kind, ty, span, Visibility::default())
    }

    /// Define a new symbol with explicit visibility.
    pub fn define_with_visibility(
        &mut self,
        name: impl Into<String>,
        kind: DefKind,
        ty: Ty,
        span: Span,
        visibility: Visibility,
    ) -> DefId {
        let name = name.into();
        let def_id = self.def_id_gen.next();

        // Build qualified name
        let qualified_name = {
            let scope = self.scope(self.current_scope).unwrap();
            let mut qn = scope.qualified_prefix.clone();
            qn.push(name.clone());
            qn
        };

        // Create the definition
        let def = Definition::new(def_id, kind, name.clone(), span)
            .with_qualified_name(qualified_name.clone())
            .with_visibility(visibility);

        let entry = SymbolEntry { def, ty };
        self.definitions.push(entry);

        // Register in current scope
        if let Some(scope) = self.scope_mut(self.current_scope) {
            scope.insert(name, def_id);
        }

        // Register in qualified names map
        self.qualified_names.insert(qualified_name, def_id);

        def_id
    }

    /// Look up a symbol by name, searching from current scope up to global.
    pub fn lookup(&self, name: &str) -> Option<DefId> {
        let mut scope_id = Some(self.current_scope);
        while let Some(id) = scope_id {
            if let Some(scope) = self.scope(id) {
                if let Some(def_id) = scope.get(name) {
                    return Some(def_id);
                }
                scope_id = scope.parent;
            } else {
                break;
            }
        }
        None
    }

    /// Look up a symbol by qualified name.
    pub fn lookup_qualified(&self, qualified_name: &[String]) -> Option<DefId> {
        self.qualified_names.get(qualified_name).copied()
    }

    /// Look up a symbol in a specific scope (no parent search).
    pub fn lookup_in_scope(&self, scope_id: ScopeId, name: &str) -> Option<DefId> {
        self.scope(scope_id).and_then(|s| s.get(name))
    }

    /// Get a definition by DefId.
    pub fn get(&self, def_id: DefId) -> Option<&SymbolEntry> {
        if def_id.is_valid() {
            self.definitions.get(def_id.0 as usize)
        } else {
            None
        }
    }

    /// Get a mutable definition by DefId.
    pub fn get_mut(&mut self, def_id: DefId) -> Option<&mut SymbolEntry> {
        if def_id.is_valid() {
            self.definitions.get_mut(def_id.0 as usize)
        } else {
            None
        }
    }

    /// Get the definition for a DefId.
    pub fn definition(&self, def_id: DefId) -> Option<&Definition> {
        self.get(def_id).map(|e| &e.def)
    }

    /// Get the type for a DefId.
    pub fn ty(&self, def_id: DefId) -> Option<&Ty> {
        self.get(def_id).map(|e| &e.ty)
    }

    /// Set the qualified prefix for the current scope.
    pub fn set_scope_prefix(&mut self, prefix: Vec<String>) {
        if let Some(scope) = self.scope_mut(self.current_scope) {
            scope.qualified_prefix = prefix;
        }
    }

    /// Associate a DefId with the current scope.
    pub fn set_scope_def(&mut self, def_id: DefId) {
        if let Some(scope) = self.scope_mut(self.current_scope) {
            scope.def_id = Some(def_id);
        }
    }

    /// Get all definitions.
    pub fn definitions(&self) -> impl Iterator<Item = &SymbolEntry> {
        self.definitions.iter()
    }

    /// Get the number of definitions.
    pub fn len(&self) -> usize {
        self.definitions.len()
    }

    /// Check if the table is empty.
    pub fn is_empty(&self) -> bool {
        self.definitions.is_empty()
    }
}

impl Default for SymbolTable {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_table() {
        let table = SymbolTable::new();
        assert!(table.is_empty());
        assert_eq!(table.current_scope(), ScopeId::ROOT);
    }

    #[test]
    fn test_define_and_lookup() {
        let mut table = SymbolTable::new();

        let def_id = table.define("foo", DefKind::Variable, Ty::Unsigned(32), Span::default());

        assert!(def_id.is_valid());
        assert_eq!(table.lookup("foo"), Some(def_id));
        assert_eq!(table.lookup("bar"), None);
    }

    #[test]
    fn test_scopes() {
        let mut table = SymbolTable::new();

        // Define in global scope
        let global_x = table.define("x", DefKind::Variable, Ty::Signed(32), Span::default());

        // Push a function scope
        let func_scope = table.push_scope(ScopeKind::Function);

        // Define in function scope (shadows global x)
        let local_x = table.define("x", DefKind::Variable, Ty::Unsigned(8), Span::default());

        // Lookup should find local x
        assert_eq!(table.lookup("x"), Some(local_x));

        // Pop back to global
        table.pop_scope();

        // Now lookup should find global x
        assert_eq!(table.lookup("x"), Some(global_x));
    }

    #[test]
    fn test_nested_scopes() {
        let mut table = SymbolTable::new();

        let a = table.define("a", DefKind::Variable, Ty::Void, Span::default());

        table.push_scope(ScopeKind::Block);
        let b = table.define("b", DefKind::Variable, Ty::Void, Span::default());

        table.push_scope(ScopeKind::Block);
        let c = table.define("c", DefKind::Variable, Ty::Void, Span::default());

        // All visible from innermost scope
        assert_eq!(table.lookup("a"), Some(a));
        assert_eq!(table.lookup("b"), Some(b));
        assert_eq!(table.lookup("c"), Some(c));

        table.pop_scope();

        // c no longer visible
        assert_eq!(table.lookup("a"), Some(a));
        assert_eq!(table.lookup("b"), Some(b));
        assert_eq!(table.lookup("c"), None);

        table.pop_scope();

        // b and c no longer visible
        assert_eq!(table.lookup("a"), Some(a));
        assert_eq!(table.lookup("b"), None);
        assert_eq!(table.lookup("c"), None);
    }

    #[test]
    fn test_qualified_names() {
        let mut table = SymbolTable::new();

        // Set up a module scope
        table.set_scope_prefix(vec!["@mymodule".to_string()]);
        let foo = table.define("foo", DefKind::Function, Ty::Void, Span::default());

        // Look up by qualified name
        let qualified = vec!["@mymodule".to_string(), "foo".to_string()];
        assert_eq!(table.lookup_qualified(&qualified), Some(foo));
    }

    #[test]
    fn test_definition_metadata() {
        let mut table = SymbolTable::new();

        let def_id = table.define_with_visibility(
            "myVar",
            DefKind::Variable,
            Ty::Unsigned(32),
            Span::default(),
            Visibility::Public,
        );

        let entry = table.get(def_id).unwrap();
        assert_eq!(entry.def.name, "myVar");
        assert_eq!(entry.def.kind, DefKind::Variable);
        assert_eq!(entry.def.visibility, Visibility::Public);
        assert_eq!(entry.ty, Ty::Unsigned(32));
    }
}
