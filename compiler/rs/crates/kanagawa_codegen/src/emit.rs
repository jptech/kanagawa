//! Main code generation orchestration.

use std::collections::HashMap;
use std::ffi::CString;

use kanagawa_hir::{HirFile, HirItem, Span};
use kanagawa_parsetree::{build_list, CStringArena};
use kanagawa_parsetree_sys::{self as sys, ParseTreeNodePtr};
use thiserror::Error;

/// Code generation error.
#[derive(Debug, Error)]
pub enum CodeGenError {
    #[error("unsupported HIR construct: {0}")]
    Unsupported(String),

    #[error("invalid string for FFI: {0}")]
    InvalidString(#[from] std::ffi::NulError),

    #[error("internal error: {0}")]
    Internal(String),
}

/// Result type for code generation.
pub type CodeGenResult<T> = Result<T, CodeGenError>;

/// Code generator state.
///
/// Manages string interning and other state needed during code generation.
pub struct CodeGen {
    /// Arena for CStrings that need to live for the duration of codegen.
    pub(crate) arena: CStringArena,
    /// Current namespace scope (for qualified names).
    pub(crate) namespace: Vec<String>,
    /// Import alias map: alias -> module namespace parts.
    /// For `import compiler.device.config as device`, this maps "device" -> ["compiler", "device", "config"]
    pub(crate) import_aliases: HashMap<String, Vec<String>>,
    /// Module re-export map: module namespace -> list of re-exported module namespaces.
    /// For `module a.b { module c.d }`, maps ["a", "b"] -> [["c", "d"]]
    /// This is populated as files are processed and used to resolve symbols through re-export chains.
    pub(crate) module_reexports: HashMap<Vec<String>, Vec<Vec<String>>>,
}

impl CodeGen {
    /// Create a new code generator.
    pub fn new() -> Self {
        Self {
            arena: CStringArena::default(),
            namespace: Vec::new(),
            import_aliases: HashMap::new(),
            module_reexports: HashMap::new(),
        }
    }

    /// Emit a complete HIR file.
    pub fn emit_file(&mut self, file: &HirFile) -> CodeGenResult<ParseTreeNodePtr> {
        // Set location for the file
        self.set_location(&file.span);

        // Clear import aliases for this file
        self.import_aliases.clear();

        // Emit all top-level items
        let mut nodes = Vec::new();

        // Parse namespace if module is present
        let namespace_parts: Vec<String> = if let Some(module) = &file.module {
            let parts: Vec<&str> = module.namespace.split('@').filter(|s| !s.is_empty()).collect();
            self.namespace = parts.iter().map(|s| s.to_string()).collect();
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_file: set namespace from module '{}' -> {:?}", module.namespace, self.namespace);
            }

            // Extract module re-exports from exports list
            // For `module a.b { module c.d }`, we record that a.b re-exports c.d
            use kanagawa_hir::HirExport;
            let mut reexports = Vec::new();
            for export in &module.exports {
                match export {
                    HirExport::Module(ns) => {
                        let reexport_parts: Vec<String> = ns
                            .split('@')
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                            .collect();
                        if !reexport_parts.is_empty() {
                            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                                eprintln!("emit_file: module {:?} re-exports {:?}", self.namespace, reexport_parts);
                            }
                            reexports.push(reexport_parts);
                        }
                    }
                    HirExport::ModuleDiff { include, exclude: _ } => {
                        // ModuleDiff means "include module minus exclude module"
                        // For now, treat it as a re-export of the include module
                        let include_parts: Vec<String> = include
                            .split('@')
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                            .collect();
                        if !include_parts.is_empty() {
                            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                                eprintln!("emit_file: module {:?} re-exports (diff) {:?}", self.namespace, include_parts);
                            }
                            reexports.push(include_parts);
                        }
                    }
                    HirExport::Name(_) => {
                        // Named exports don't affect module re-exports
                    }
                }
            }
            if !reexports.is_empty() {
                self.module_reexports.insert(self.namespace.clone(), reexports);
            }

            self.namespace.clone()
        } else {
            // Reset namespace for files without module declaration
            self.namespace.clear();
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_file: no module, namespace is empty");
            }
            Vec::new()
        };

        // Build import alias map from imports
        // For `import compiler.device.config as device`, we map "device" -> ["compiler", "device", "config"]
        for import in &file.imports {
            self.set_location(&import.span);
            // Parse the namespace "@compiler@device@config" -> ["compiler", "device", "config"]
            let mut ns_parts: Vec<String> = import.namespace
                .split('@')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();

            // Handle synthetic .options module - rewrite to compiler.options
            // The Haskell frontend generates .options as a synthetic module that re-exports compiler.options
            // The namespace comes in as "@.options@" (with the dot) or ns_parts would be [".options"]
            if ns_parts == vec![".options".to_string()] || import.namespace == "@.options@" {
                ns_parts = vec!["compiler".to_string(), "options".to_string()];
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("emit_file: rewrote .options import to {:?}", ns_parts);
                }
            }
            // Also handle .cmdargs - rewrite to empty for now (synthetic command-line args module)
            if ns_parts == vec![".cmdargs".to_string()] || import.namespace == "@.cmdargs@" {
                // Skip .cmdargs for now - it's a synthetic module for command-line defines
                continue;
            }

            if let Some(alias) = &import.alias {
                // Explicit alias: import foo.bar as baz -> baz maps to [foo, bar]
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("emit_file: import alias '{}' -> {:?}", alias, ns_parts);
                }
                self.import_aliases.insert(alias.clone(), ns_parts);
            } else if !ns_parts.is_empty() {
                // No alias: import foo.bar -> bar maps to [foo, bar]
                // The last component is used as the implicit alias
                let implicit_alias = ns_parts.last().unwrap().clone();
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("emit_file: implicit import alias '{}' -> {:?}", implicit_alias, ns_parts);
                }
                self.import_aliases.insert(implicit_alias, ns_parts);
            }
        }

        // Emit each top-level item
        // Skip items that fail with Unsupported (e.g., templates with auto types)
        for item in &file.items {
            match self.emit_item(item) {
                Ok(Some(node)) => nodes.push(node),
                Ok(None) => {}
                Err(CodeGenError::Unsupported(msg)) => {
                    if std::env::var("KANAGAWA_DEBUG").is_ok() {
                        eprintln!("Skipping item due to unsupported construct: {}", msg);
                    }
                }
                Err(e) => return Err(e),
            }
        }

        // Build the list of items
        let mut result = build_list(&nodes);

        // If there's a module namespace, wrap the items in nested ParseNamespace nodes
        // We wrap from innermost to outermost, so for "a.b.c" we get:
        // ParseNamespace("a", ParseNamespace("b", ParseNamespace("c", items)))
        if !namespace_parts.is_empty() {
            // Wrap from innermost to outermost
            for part in namespace_parts.iter().rev() {
                let ns_id = self.identifier(part);
                result = unsafe { sys::ParseNamespace(ns_id, result) };
            }
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("emit_file: wrapped items in namespace {:?}", namespace_parts);
            }
        }

        Ok(result)
    }

    /// Emit a single HIR item.
    pub(crate) fn emit_item(&mut self, item: &HirItem) -> CodeGenResult<Option<ParseTreeNodePtr>> {
        use crate::decl::emit_item;
        emit_item(self, item)
    }

    /// Set the current source location.
    pub(crate) fn set_location(&self, span: &Span) {
        // WORKAROUND: Use file_index 0 to avoid out-of-bounds access
        // when library files aren't in the _fileNames array passed to InitCompiler.
        // The correct fix would be to collect all files (including imports) and
        // pass them to InitCompiler, then use proper file indices.
        let loc = sys::Location {
            _beginLine: span.start as usize,
            _beginColumn: 1, // We don't track columns precisely yet
            _endLine: span.end as usize,
            _endColumn: 1,
            _fileIndex: 0, // Always use first file to avoid index issues
            _valid: true,
        };
        unsafe {
            sys::SetLocation2(&loc);
        }
    }

    /// Intern a string and return a pointer valid for the codegen lifetime.
    pub(crate) fn intern(&mut self, s: &str) -> *const std::os::raw::c_char {
        self.arena.push(s)
    }

    /// Intern a CString and return a pointer.
    pub(crate) fn intern_cstring(&mut self, s: CString) -> *const std::os::raw::c_char {
        self.arena.push_cstring(s)
    }

    /// Build a null-terminated array of namespace scope pointers.
    /// Returns a pointer to the array that is valid for the codegen lifetime.
    ///
    /// IMPORTANT: The C++ ToScope function uses push_front when iterating,
    /// so we must provide the array in REVERSE order (innermost-to-outermost).
    /// For namespace ["compiler", "device", "schema"], we provide ["schema", "device", "compiler", NULL].
    pub(crate) fn namespace_scope(&mut self) -> sys::ParseNamespaceScopePtr {
        if self.namespace.is_empty() {
            if std::env::var("KANAGAWA_DEBUG_NS").is_ok() {
                eprintln!("namespace_scope: returning null (global scope)");
            }
            return std::ptr::null();
        }

        if std::env::var("KANAGAWA_DEBUG_NS").is_ok() {
            eprintln!("namespace_scope: building scope for {:?}", self.namespace);
        }

        // Clone namespace to avoid borrow conflict with self.intern_cstring
        let parts = self.namespace.clone();

        // Build a proper pointer array for the namespace scope
        // REVERSED: innermost-to-outermost order for C++ ToScope's push_front
        let mut ptrs: Vec<*const std::os::raw::c_char> = Vec::with_capacity(parts.len() + 1);
        for part in parts.iter().rev() {
            let cstr = CString::new(part.as_str()).expect("valid namespace part");
            ptrs.push(self.intern_cstring(cstr));
        }
        ptrs.push(std::ptr::null()); // Null terminator

        if std::env::var("KANAGAWA_DEBUG_NS").is_ok() {
            eprintln!("namespace_scope: built array with {} parts (reversed)", parts.len());
        }

        // Store the pointer array in a boxed slice and leak it
        let boxed: Box<[*const std::os::raw::c_char]> = ptrs.into_boxed_slice();
        Box::leak(boxed).as_ptr()
    }

    /// Build a scope from name parts (for declarations with qualified names).
    /// Takes a slice of name parts like ["Color", "Red"].
    /// Returns a pointer to a null-terminated array of C string pointers.
    ///
    /// IMPORTANT: The C++ ToScope function uses push_front when iterating,
    /// so we must provide the array in REVERSE order (innermost-to-outermost).
    pub(crate) fn make_scope_parts(&mut self, name_parts: &[&str]) -> sys::ParseNamespaceScopePtr {
        // Build qualified name by combining namespace and name parts
        let mut parts: Vec<String> = self.namespace.clone();
        for part in name_parts {
            parts.push(part.to_string());
        }

        // Allocate storage for the pointer array in the arena
        // REVERSED: innermost-to-outermost order for C++ ToScope's push_front
        let mut ptrs: Vec<*const std::os::raw::c_char> = Vec::with_capacity(parts.len() + 1);
        for part in parts.iter().rev() {
            let cstr = CString::new(part.as_str()).expect("valid identifier");
            ptrs.push(self.intern_cstring(cstr));
        }
        ptrs.push(std::ptr::null()); // Null terminator

        // Store the pointer array in a boxed slice and leak it
        let boxed: Box<[*const std::os::raw::c_char]> = ptrs.into_boxed_slice();
        Box::leak(boxed).as_ptr()
    }

    /// Build a scope from a single name (for top-level declarations).
    /// Returns a pointer to a null-terminated array of C string pointers.
    pub(crate) fn make_scope(&mut self, name: &str) -> sys::ParseNamespaceScopePtr {
        self.make_scope_parts(&[name])
    }

    /// Create an identifier node.
    pub(crate) fn identifier(&mut self, name: &str) -> ParseTreeNodePtr {
        let cstr = CString::new(name).expect("valid identifier");
        let ptr = self.intern_cstring(cstr);
        unsafe { sys::ParseIdentifier(ptr) }
    }

    /// Create a scoped identifier node from a simple name.
    /// This wraps ParseIdentifier -> ParseBaseList -> ParseScopedIdentifier.
    pub(crate) fn scoped_identifier(&mut self, name: &str) -> ParseTreeNodePtr {
        let id = self.identifier(name);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("scoped_identifier: ParseIdentifier('{}') = {:?}", name, id);
        }
        let list = unsafe { sys::ParseBaseList(id) };
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("scoped_identifier: ParseBaseList = {:?}", list);
        }
        let scoped = unsafe { sys::ParseScopedIdentifier(list) };
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("scoped_identifier: ParseScopedIdentifier = {:?}", scoped);
        }
        scoped
    }

    /// Create a scoped identifier node from a qualified path (e.g., ["Foo", "Bar"]).
    /// Each component becomes an identifier in the scoped name.
    /// If the first component is an import alias, it's expanded to the full module path.
    pub(crate) fn qualified_scoped_identifier(&mut self, path: &[String]) -> ParseTreeNodePtr {
        // Resolve import alias if the first component matches
        let resolved_path = self.resolve_import_alias(path);

        // Build list of identifiers
        let mut list = unsafe { sys::ParseBaseList(std::ptr::null_mut()) };
        for part in &resolved_path {
            let id = self.identifier(part);
            list = unsafe { sys::ParseAppendList(list, id) };
        }
        unsafe { sys::ParseScopedIdentifier(list) }
    }

    /// Resolve import aliases in a qualified path.
    /// If the first component is an import alias, expand it to the full module path.
    /// Then, if the target module has re-exports, follow them to find the actual symbol location.
    ///
    /// For example: ["device", "device_name"] with import alias "device" -> ["compiler", "device", "config"]
    /// And if ["compiler", "device", "config"] re-exports ["hardware", "config"],
    /// the result is ["hardware", "config", "device_name"] (where the symbol is actually defined).
    pub(crate) fn resolve_import_alias(&self, path: &[String]) -> Vec<String> {
        if path.is_empty() {
            return path.to_vec();
        }

        let first = &path[0];
        let (module_path, symbol_parts) = if let Some(alias_target) = self.import_aliases.get(first) {
            // Found an import alias - expand it
            // path = ["device", "device_name"], alias_target = ["compiler", "device", "config"]
            // module_path = ["compiler", "device", "config"], symbol_parts = ["device_name"]
            (alias_target.clone(), path[1..].to_vec())
        } else {
            // Not an alias - could be a qualified path like ["compiler", "device", "config", "device_name"]
            // In this case, try to find a module prefix that matches a re-export
            // For now, just return as-is
            return path.to_vec();
        };

        // Check if the target module has re-exports
        // If so, try the re-exported modules as the base for the symbol
        if let Some(reexports) = self.module_reexports.get(&module_path) {
            // The module re-exports other modules - find a re-export that's different from the source
            // This handles the common case where a bridge module re-exports a single module
            // (e.g., compiler.device.config re-exports hardware.config)
            // Skip self-references from ModuleDiff { include: self, exclude: other }
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!(
                    "resolve_import_alias: module {:?} re-exports {:?}",
                    module_path,
                    reexports
                );
            }
            for reexport in reexports {
                if reexport != &module_path {
                    let mut result = reexport.clone();
                    result.extend(symbol_parts.clone());
                    if std::env::var("KANAGAWA_DEBUG").is_ok() {
                        eprintln!(
                            "resolve_import_alias: resolved via re-export -> {:?}",
                            result
                        );
                    }
                    return result;
                }
            }
        } else if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!(
                "resolve_import_alias: no re-exports for {:?}",
                module_path
            );
        }

        // No re-exports, use the module path directly
        let mut result = module_path;
        result.extend(symbol_parts);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!(
                "resolve_import_alias: expanded '{}' -> {:?}",
                path.join("::"),
                result
            );
        }
        result
    }
}

impl Default for CodeGen {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanagawa_hir::{HirFile, Span};

    // Note: This test requires the C++ backend to be initialized (InitCompiler called).
    // It is ignored by default because unit tests cannot easily initialize the backend.
    // Run integration tests with the full driver for end-to-end testing.
    #[test]
    #[ignore = "requires C++ backend initialization"]
    fn test_empty_file() {
        let file = HirFile {
            span: Span::default(),
            module: None,
            imports: Vec::new(),
            items: Vec::new(),
        };

        let mut codegen = CodeGen::new();
        let result = codegen.emit_file(&file);
        assert!(result.is_ok());
    }
}
