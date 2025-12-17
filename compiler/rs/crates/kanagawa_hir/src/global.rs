//! Global type registry for cross-module type resolution.
//!
//! During multi-file compilation, types from imported modules need to be
//! available when lowering dependent files. This module provides a registry
//! that collects type definitions from all processed modules.

use crate::ty::Ty;
use std::collections::HashMap;

/// A type definition from a module.
#[derive(Debug, Clone)]
pub struct TypeDef {
    /// The module namespace (e.g., "@compiler@device@schema").
    pub namespace: String,
    /// The type name (e.g., "MemoryConfiguration").
    pub name: String,
    /// The fully resolved type.
    pub ty: Ty,
}

/// Global type registry for cross-module type resolution.
///
/// This registry is populated as modules are processed and allows later
/// modules to resolve types from earlier-processed modules.
#[derive(Debug, Default)]
pub struct GlobalTypeRegistry {
    /// Types indexed by their simple name.
    /// Multiple types with the same name from different modules can exist.
    types_by_name: HashMap<String, Vec<TypeDef>>,

    /// Types indexed by qualified name (namespace + "::" + name).
    types_by_qualified: HashMap<String, TypeDef>,

    /// Module namespace to list of exported type names.
    module_exports: HashMap<String, Vec<String>>,
}

impl GlobalTypeRegistry {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a type from a module.
    pub fn register_type(&mut self, namespace: &str, name: &str, ty: Ty) {
        let type_def = TypeDef {
            namespace: namespace.to_string(),
            name: name.to_string(),
            ty,
        };

        // Index by simple name
        self.types_by_name
            .entry(name.to_string())
            .or_insert_with(Vec::new)
            .push(type_def.clone());

        // Index by qualified name
        let qualified = if namespace.is_empty() {
            name.to_string()
        } else {
            format!("{}::{}", namespace, name)
        };
        self.types_by_qualified.insert(qualified, type_def);

        // Track module exports
        self.module_exports
            .entry(namespace.to_string())
            .or_insert_with(Vec::new)
            .push(name.to_string());
    }

    /// Look up a type by its simple name.
    /// Returns None if not found or if multiple types with the same name exist.
    pub fn lookup_by_name(&self, name: &str) -> Option<&Ty> {
        let defs = self.types_by_name.get(name)?;
        if defs.len() == 1 {
            Some(&defs[0].ty)
        } else {
            // Ambiguous - multiple types with the same name
            None
        }
    }

    /// Look up a type by simple name and return a Reference type with the qualified path.
    /// This is preferred for codegen as it allows the backend to resolve the type via DeferredType.
    pub fn lookup_as_reference(&self, name: &str) -> Option<Ty> {
        let defs = self.types_by_name.get(name)?;
        if defs.len() == 1 {
            let def = &defs[0];
            // Build the qualified path for the reference
            let path = vec![def.namespace.clone(), def.name.clone()];
            Some(Ty::Reference(path))
        } else {
            // Ambiguous - multiple types with the same name
            None
        }
    }

    /// Look up a type by qualified name (namespace + "::" + name).
    pub fn lookup_qualified(&self, namespace: &str, name: &str) -> Option<&Ty> {
        let qualified = if namespace.is_empty() {
            name.to_string()
        } else {
            format!("{}::{}", namespace, name)
        };
        self.types_by_qualified.get(&qualified).map(|d| &d.ty)
    }

    /// Look up a type by path parts (e.g., ["compiler", "device", "schema", "MemoryType"]).
    /// The last element is the type name, the rest form the namespace.
    pub fn lookup_by_path(&self, path: &[String]) -> Option<&Ty> {
        if path.is_empty() {
            return None;
        }

        if path.len() == 1 {
            // Simple name lookup
            return self.lookup_by_name(&path[0]);
        }

        // Try qualified lookup
        // Path is ["compiler", "device", "schema", "MemoryType"]
        // Namespace is "@compiler@device@schema"
        // Name is "MemoryType"
        let name = &path[path.len() - 1];
        let namespace_parts = &path[..path.len() - 1];
        let namespace: String = namespace_parts.iter()
            .map(|s| format!("@{}", s))
            .collect();

        self.lookup_qualified(&namespace, name)
    }

    /// Look up a type by path and return a Reference type with the qualified path.
    /// This is preferred for codegen as it allows the backend to resolve the type via DeferredType.
    pub fn lookup_path_as_reference(&self, path: &[String]) -> Option<Ty> {
        if path.is_empty() {
            return None;
        }

        if path.len() == 1 {
            return self.lookup_as_reference(&path[0]);
        }

        // Build namespace and name from path
        let name = &path[path.len() - 1];
        let namespace_parts = &path[..path.len() - 1];
        let namespace: String = namespace_parts.iter()
            .map(|s| format!("@{}", s))
            .collect();

        // Check if the type exists
        let qualified = format!("{}::{}", namespace, name);
        if self.types_by_qualified.contains_key(&qualified) {
            // Return a reference type with the qualified path
            Some(Ty::Reference(vec![namespace, name.clone()]))
        } else {
            None
        }
    }

    /// Get all types from a module namespace.
    pub fn types_from_module(&self, namespace: &str) -> Vec<(&String, &Ty)> {
        let mut result = Vec::new();
        if let Some(names) = self.module_exports.get(namespace) {
            for name in names {
                if let Some(ty) = self.lookup_qualified(namespace, name) {
                    result.push((name, ty));
                }
            }
        }
        result
    }

    /// Get the number of registered types.
    pub fn len(&self) -> usize {
        self.types_by_qualified.len()
    }

    /// Check if the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.types_by_qualified.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_and_lookup() {
        let mut registry = GlobalTypeRegistry::new();

        registry.register_type("@mymodule", "MyType", Ty::Unsigned(32));

        // Lookup by simple name
        assert_eq!(registry.lookup_by_name("MyType"), Some(&Ty::Unsigned(32)));

        // Lookup by qualified name
        assert_eq!(registry.lookup_qualified("@mymodule", "MyType"), Some(&Ty::Unsigned(32)));

        // Lookup by path
        let path = vec!["mymodule".to_string(), "MyType".to_string()];
        assert_eq!(registry.lookup_by_path(&path), Some(&Ty::Unsigned(32)));
    }

    #[test]
    fn test_ambiguous_names() {
        let mut registry = GlobalTypeRegistry::new();

        // Register two types with the same name in different modules
        registry.register_type("@mod1", "Foo", Ty::Unsigned(8));
        registry.register_type("@mod2", "Foo", Ty::Signed(16));

        // Simple name lookup should fail (ambiguous)
        assert_eq!(registry.lookup_by_name("Foo"), None);

        // Qualified lookup should work
        assert_eq!(registry.lookup_qualified("@mod1", "Foo"), Some(&Ty::Unsigned(8)));
        assert_eq!(registry.lookup_qualified("@mod2", "Foo"), Some(&Ty::Signed(16)));
    }

    #[test]
    fn test_types_from_module() {
        let mut registry = GlobalTypeRegistry::new();

        registry.register_type("@mymod", "TypeA", Ty::Bool);
        registry.register_type("@mymod", "TypeB", Ty::String);
        registry.register_type("@other", "TypeC", Ty::Float);

        let types = registry.types_from_module("@mymod");
        assert_eq!(types.len(), 2);

        let names: Vec<_> = types.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"TypeA"));
        assert!(names.contains(&"TypeB"));
        assert!(!names.contains(&"TypeC"));
    }
}
