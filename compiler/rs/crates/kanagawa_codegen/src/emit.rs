//! Main code generation orchestration.

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
}

impl CodeGen {
    /// Create a new code generator.
    pub fn new() -> Self {
        Self {
            arena: CStringArena::default(),
            namespace: Vec::new(),
        }
    }

    /// Emit a complete HIR file.
    pub fn emit_file(&mut self, file: &HirFile) -> CodeGenResult<ParseTreeNodePtr> {
        // Set location for the file
        self.set_location(&file.span);

        // Emit all top-level items
        let mut nodes = Vec::new();

        // Emit module namespace if present
        if let Some(module) = &file.module {
            // Parse the namespace string into components
            let parts: Vec<&str> = module.namespace.split('@').filter(|s| !s.is_empty()).collect();
            self.namespace = parts.iter().map(|s| s.to_string()).collect();
        }

        // Emit imports (currently just as identifiers for the backend to resolve)
        for import in &file.imports {
            self.set_location(&import.span);
            // Backend handles imports differently - we may need to emit ParseNamespace
            // For now, skip imports as the backend resolves them
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

        Ok(build_list(&nodes))
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
    pub(crate) fn namespace_scope(&mut self) -> sys::ParseNamespaceScopePtr {
        if self.namespace.is_empty() {
            return std::ptr::null();
        }

        // This is a simplification - we'd need to build a proper pointer array
        // For now, return null which means global scope
        std::ptr::null()
    }

    /// Build a scope from name parts (for declarations with qualified names).
    /// Takes a slice of name parts like ["Color", "Red"].
    /// Returns a pointer to a null-terminated array of C string pointers.
    pub(crate) fn make_scope_parts(&mut self, name_parts: &[&str]) -> sys::ParseNamespaceScopePtr {
        // Build qualified name by combining namespace and name parts
        let mut parts: Vec<String> = self.namespace.clone();
        for part in name_parts {
            parts.push(part.to_string());
        }

        // Allocate storage for the pointer array in the arena
        let mut ptrs: Vec<*const std::os::raw::c_char> = Vec::with_capacity(parts.len() + 1);
        for part in &parts {
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
    pub(crate) fn qualified_scoped_identifier(&mut self, path: &[String]) -> ParseTreeNodePtr {
        // Build list of identifiers
        let mut list = unsafe { sys::ParseBaseList(std::ptr::null_mut()) };
        for part in path {
            let id = self.identifier(part);
            list = unsafe { sys::ParseAppendList(list, id) };
        }
        unsafe { sys::ParseScopedIdentifier(list) }
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
