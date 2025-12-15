//! Semantic type representation.
//!
//! This module defines the semantic type system for HIR, closely following
//! the Haskell frontend's `Type.hs`. Types here have resolved names and
//! concrete information where known.


/// Semantic type.
///
/// Unlike AST types which are syntactic, HIR types are semantic:
/// - Names are resolved to DefIds
/// - Widths are known where possible
/// - Template instances are explicit
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ty {
    // ========================================================================
    // Special types
    // ========================================================================
    /// Auto type (to be inferred).
    Auto,
    /// Template type placeholder.
    Template,
    /// Type of a type (metatype): `type T` evaluates to `TType(T)`.
    Type(Box<Ty>),
    /// Undefined (used during resolution).
    Undefined,
    /// Untyped (for statements and other non-expression nodes).
    Untyped,
    /// Unresolved (name resolution pending).
    Unresolved,
    /// Error type with message.
    Error(String),

    // ========================================================================
    // Primitive types
    // ========================================================================
    /// Void type.
    Void,
    /// Boolean type.
    Bool,
    /// 32-bit floating point.
    Float,
    /// String type.
    String,

    // ========================================================================
    // Integer types
    // ========================================================================
    /// Signed integer with fixed width.
    Signed(u32),
    /// Unsigned integer with fixed width.
    Unsigned(u32),
    /// Dependent integer type (width depends on template parameter).
    Dependent(Box<Ty>),

    // ========================================================================
    // Compound types
    // ========================================================================
    /// Const-qualified type.
    Const(Box<Ty>),
    /// Reference type.
    Reference(Vec<String>),
    /// Array type with attributes, element type, and dimensions.
    Array {
        attrs: Vec<TyAttr>,
        element: Box<Ty>,
        dims: Vec<i64>,
    },
    /// Function type.
    Function {
        kind: FunctionKind,
        attrs: Vec<TyAttr>,
        return_ty: Box<Ty>,
        params: Vec<TyFuncParam>,
    },
    /// Closure type.
    Closure {
        function: Vec<String>,
        func_ty: Box<Ty>,
        capture_ty: Box<Ty>,
        qualified_name: Vec<String>,
    },

    // ========================================================================
    // Named types
    // ========================================================================
    /// Enum type with base type.
    Enum {
        name: Vec<String>,
        base: Box<Ty>,
    },
    /// Struct type with fields.
    Struct {
        name: Vec<String>,
        fields: Vec<(String, Ty)>,
    },
    /// Union type with fields.
    Union {
        name: Vec<String>,
        fields: Vec<(String, Ty)>,
    },
    /// Class type with fields.
    Class {
        name: Vec<String>,
        fields: Vec<(String, Ty)>,
    },
    /// Template instance.
    Instance {
        template: Box<Ty>,
        name: Vec<String>,
        args: Vec<(String, TyArg)>,
    },

    // ========================================================================
    // Initializer types
    // ========================================================================
    /// Initializer list type.
    Initializer(Vec<Ty>),
    /// Designator type: `.field = value`.
    Designator {
        name: String,
        ty: Box<Ty>,
    },
    /// Positional initializer type.
    Positional {
        index: usize,
        ty: Box<Ty>,
    },
}

impl Ty {
    /// Check if this type is resolved (not pending resolution).
    pub fn is_resolved(&self) -> bool {
        match self {
            Ty::Auto => true,
            Ty::Template => false,
            Ty::Type(t) => t.is_resolved(),
            Ty::Undefined => false,
            Ty::Untyped => true,
            Ty::Unresolved => false,
            Ty::Error(_) => true,
            Ty::Void | Ty::Bool | Ty::Float | Ty::String => true,
            Ty::Signed(_) | Ty::Unsigned(_) => true,
            Ty::Dependent(t) => t.is_resolved(),
            Ty::Const(t) => t.is_resolved(),
            Ty::Reference(_) => true,
            Ty::Array { element, dims, attrs } => {
                element.is_resolved() && !dims.is_empty() && attrs.iter().all(|a| a.is_resolved())
            }
            Ty::Function { return_ty, params, .. } => {
                return_ty.is_resolved() && params.iter().all(|p| p.ty.is_resolved())
            }
            Ty::Closure { func_ty, capture_ty, .. } => {
                func_ty.is_resolved() && capture_ty.is_resolved()
            }
            Ty::Enum { base, .. } => base.is_resolved(),
            Ty::Struct { fields, .. } | Ty::Union { fields, .. } | Ty::Class { fields, .. } => {
                fields.iter().all(|(_, t)| t.is_resolved())
            }
            Ty::Instance { template, .. } => template.is_resolved(),
            Ty::Initializer(ts) => ts.iter().all(|t| t.is_resolved()),
            Ty::Designator { ty, .. } | Ty::Positional { ty, .. } => ty.is_resolved(),
        }
    }

    /// Check if this is an error type.
    pub fn is_error(&self) -> bool {
        matches!(self, Ty::Error(_))
    }

    /// Check if this is void.
    pub fn is_void(&self) -> bool {
        matches!(self, Ty::Void) || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_void())
    }

    /// Check if this is an integer type.
    pub fn is_int(&self) -> bool {
        self.is_signed() || self.is_unsigned()
    }

    /// Check if this is signed.
    pub fn is_signed(&self) -> bool {
        matches!(self, Ty::Signed(_))
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_signed())
    }

    /// Check if this is unsigned.
    pub fn is_unsigned(&self) -> bool {
        matches!(self, Ty::Unsigned(_))
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_unsigned())
    }

    /// Check if this is a boolean.
    pub fn is_bool(&self) -> bool {
        matches!(self, Ty::Bool)
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_bool())
    }

    /// Check if this is a float.
    pub fn is_float(&self) -> bool {
        matches!(self, Ty::Float)
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_float())
    }

    /// Check if this is a string.
    pub fn is_string(&self) -> bool {
        matches!(self, Ty::String)
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_string())
    }

    /// Check if this is const-qualified.
    pub fn is_const(&self) -> bool {
        matches!(self, Ty::Const(_))
    }

    /// Check if this is an array.
    pub fn is_array(&self) -> bool {
        matches!(self, Ty::Array { .. })
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_array())
    }

    /// Check if this is a function type.
    pub fn is_function(&self) -> bool {
        matches!(self, Ty::Function { .. })
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_function())
    }

    /// Check if this is a struct.
    pub fn is_struct(&self) -> bool {
        matches!(self, Ty::Struct { .. })
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_struct())
    }

    /// Check if this is a class.
    pub fn is_class(&self) -> bool {
        matches!(self, Ty::Class { .. })
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_class())
    }

    /// Check if this is a union.
    pub fn is_union(&self) -> bool {
        matches!(self, Ty::Union { .. })
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_union())
    }

    /// Check if this is an enum.
    pub fn is_enum(&self) -> bool {
        matches!(self, Ty::Enum { .. })
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_enum())
    }

    /// Check if this is a template instance.
    pub fn is_instance(&self) -> bool {
        matches!(self, Ty::Instance { .. })
    }

    /// Check if this is a type (metatype).
    pub fn is_type(&self) -> bool {
        matches!(self, Ty::Type(_))
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_type())
    }

    /// Check if this is a closure.
    pub fn is_closure(&self) -> bool {
        matches!(self, Ty::Closure { .. })
            || matches!(self, Ty::Const(t) | Ty::Instance { template: t, .. } if t.is_closure())
    }

    /// Get the bit width of this type, if known.
    pub fn width(&self) -> Option<u32> {
        match self {
            Ty::Void | Ty::Auto | Ty::Template | Ty::Undefined | Ty::Untyped |
            Ty::Unresolved | Ty::Error(_) | Ty::Function { .. } | Ty::Class { .. } => None,
            Ty::Bool => Some(1),
            Ty::Float => Some(32),
            Ty::String => Some(0),
            Ty::Signed(w) | Ty::Unsigned(w) => Some(*w),
            Ty::Dependent(t) | Ty::Const(t) | Ty::Type(t) => t.width(),
            Ty::Reference(_) => Some(1),
            Ty::Array { element, dims, .. } => {
                let elem_width = element.width()?;
                let total_elems: i64 = dims.iter().product();
                Some(elem_width * total_elems as u32)
            }
            Ty::Closure { capture_ty, .. } => capture_ty.width(),
            Ty::Enum { base, .. } => base.width(),
            Ty::Struct { fields, .. } => fields.iter().try_fold(0u32, |acc, (_, t)| Some(acc + t.width()?)),
            Ty::Union { fields, .. } => fields.iter().filter_map(|(_, t)| t.width()).max(),
            Ty::Instance { template, .. } => template.width(),
            Ty::Initializer(_) => None,
            Ty::Designator { ty, .. } | Ty::Positional { ty, .. } => ty.width(),
        }
    }

    /// Get the element type if this is an array.
    pub fn element(&self) -> Option<&Ty> {
        match self {
            Ty::Array { element, .. } => Some(element),
            Ty::Const(t) | Ty::Instance { template: t, .. } => t.element(),
            _ => None,
        }
    }

    /// Get the return type if this is a function.
    pub fn return_type(&self) -> Option<&Ty> {
        match self {
            Ty::Function { return_ty, .. } => Some(return_ty),
            Ty::Const(t) | Ty::Instance { template: t, .. } => t.return_type(),
            Ty::Closure { func_ty, .. } => func_ty.return_type(),
            _ => None,
        }
    }

    /// Get the qualified name if this is a named type.
    pub fn qualified_name(&self) -> Option<&[String]> {
        match self {
            Ty::Enum { name, .. } | Ty::Struct { name, .. } |
            Ty::Union { name, .. } | Ty::Class { name, .. } |
            Ty::Closure { qualified_name: name, .. } |
            Ty::Reference(name) => Some(name),
            Ty::Instance { name, .. } => Some(name),
            Ty::Const(t) => t.qualified_name(),
            _ => None,
        }
    }

    /// Strip const qualification.
    pub fn unconst(&self) -> &Ty {
        match self {
            Ty::Const(t) => t.unconst(),
            t => t,
        }
    }
}

impl Default for Ty {
    fn default() -> Self {
        Ty::Unresolved
    }
}

/// Function kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FunctionKind {
    /// Free function.
    Free,
    /// Member function (method).
    Member,
    /// Lambda function.
    Lambda,
}

impl Default for FunctionKind {
    fn default() -> Self {
        FunctionKind::Free
    }
}

/// Type attribute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TyAttr {
    /// Flag attribute (e.g., async, pipelined).
    Flag(TyAttrFlag),
    /// Integer attribute (e.g., latency(N)).
    Int {
        name: TyAttrName,
        value: i64,
    },
    /// Named attribute with qualified name.
    Named {
        name: TyAttrName,
        qualified_name: Vec<String>,
        ty: Box<Ty>,
    },
}

impl TyAttr {
    fn is_resolved(&self) -> bool {
        match self {
            TyAttr::Flag(_) | TyAttr::Int { .. } => true,
            TyAttr::Named { ty, .. } => ty.is_resolved(),
        }
    }
}

/// Flag-style type attributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TyAttrFlag {
    Async,
    Atomic,
    EndTransaction,
    Initialize,
    Memory,
    NoBackPressure,
    Pure,
    NonReplicated,
    Pipelined,
    QuadPort,
    ReorderByLooping,
    Reset,
    Unordered,
}

/// Named type attributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TyAttrName {
    CallRate,
    Ecc,
    FifoDepth,
    Latency,
    MaxThreads,
    Rename,
    Schedule,
    ThreadRate,
    TransactionSize,
}

/// Function type parameter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TyFuncParam {
    /// Parameter attributes.
    pub attrs: Vec<TyAttr>,
    /// Parameter type.
    pub ty: Ty,
    /// Parameter name (optional for function types).
    pub name: Option<String>,
}

/// Template argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TyArg {
    /// String argument.
    Str(String),
    /// Type argument.
    Type(Ty),
    /// Integer argument.
    Int(i64),
    /// Named argument (type with qualified name).
    Named {
        ty: Ty,
        name: Vec<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_primitive_types() {
        assert!(Ty::Void.is_void());
        assert!(Ty::Bool.is_bool());
        assert!(Ty::Float.is_float());
        assert!(Ty::String.is_string());
    }

    #[test]
    fn test_integer_types() {
        assert!(Ty::Signed(32).is_int());
        assert!(Ty::Signed(32).is_signed());
        assert!(!Ty::Signed(32).is_unsigned());

        assert!(Ty::Unsigned(8).is_int());
        assert!(Ty::Unsigned(8).is_unsigned());
        assert!(!Ty::Unsigned(8).is_signed());
    }

    #[test]
    fn test_widths() {
        assert_eq!(Ty::Bool.width(), Some(1));
        assert_eq!(Ty::Float.width(), Some(32));
        assert_eq!(Ty::Signed(32).width(), Some(32));
        assert_eq!(Ty::Unsigned(8).width(), Some(8));
        assert_eq!(Ty::Void.width(), None);
    }

    #[test]
    fn test_const_type() {
        let const_int = Ty::Const(Box::new(Ty::Signed(32)));
        assert!(const_int.is_const());
        assert!(const_int.is_int());
        assert_eq!(const_int.unconst(), &Ty::Signed(32));
    }

    #[test]
    fn test_array_type() {
        let arr = Ty::Array {
            attrs: Vec::new(),
            element: Box::new(Ty::Unsigned(8)),
            dims: vec![10],
        };
        assert!(arr.is_array());
        assert_eq!(arr.element(), Some(&Ty::Unsigned(8)));
        assert_eq!(arr.width(), Some(80));
    }

    #[test]
    fn test_resolution() {
        assert!(Ty::Void.is_resolved());
        assert!(Ty::Signed(32).is_resolved());
        assert!(!Ty::Unresolved.is_resolved());
        assert!(!Ty::Undefined.is_resolved());
        assert!(!Ty::Template.is_resolved());
    }

    #[test]
    fn test_function_type() {
        let func = Ty::Function {
            kind: FunctionKind::Free,
            attrs: Vec::new(),
            return_ty: Box::new(Ty::Void),
            params: vec![
                TyFuncParam {
                    attrs: Vec::new(),
                    ty: Ty::Unsigned(32),
                    name: Some("x".to_string()),
                },
            ],
        };
        assert!(func.is_function());
        assert_eq!(func.return_type(), Some(&Ty::Void));
    }
}
