; Module definitions
(module_decl
  name: (module_name) @module.name) @module

; Class, struct, union definitions
; Note: Both templated and non-templated versions are matched.
; Deduplication happens in extractSymbols() based on name node position.

(class_decl
  name: (identifier) @class.name) @class

(class_template
  (class_decl
    name: (identifier) @class.name)) @class

(struct_decl
  name: (identifier) @struct.name) @struct

(struct_template
  (struct_decl
    name: (identifier) @struct.name)) @struct

(union_decl
  name: (identifier) @union.name) @union

(union_template
  (union_decl
    name: (identifier) @union.name)) @union

(enum_decl
  name: (identifier) @enum.name) @enum

; Function definitions
(function_definition
  name: (identifier) @function.name) @function

(function_template
  (function_definition
    name: (identifier) @function.name)) @function

; Type aliases
(alias_decl
  name: (identifier) @alias.name) @alias

(alias_template
  name: (identifier) @alias.name) @alias

; Global variables (at source_file level)
(source_file
  (declaration
    (variable_decl
      name: (identifier) @variable.name)) @variable)

; Module-level variables/constants (inside module_decl)
; Note: module_decl can contain declaration children directly
(module_decl
  (declaration
    (variable_decl
      name: (identifier) @variable.name)) @variable)

; Member variables (inside classes/structs)
(member_decl
  (declaration
    (variable_decl
      name: (identifier) @member.name))) @member

(member_decl
  (variable_decl
    name: (identifier) @member.name)) @member

; Enum constants
(enum_constant
  name: (identifier) @constant.name) @constant

; Documentation comments (for association with definitions)
(comment) @doc.comment
