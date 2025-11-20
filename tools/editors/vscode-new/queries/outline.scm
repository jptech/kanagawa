; Document Outline Query
; Used for the VS Code document symbol provider

(module_decl
  name: (module_name) @name) @module

(class_decl
  name: (identifier) @name) @class

(class_template
  (class_decl
    name: (identifier) @name)) @class

(struct_decl
  name: (identifier) @name) @struct

(struct_template
  (struct_decl
    name: (identifier) @name)) @struct

(union_decl
  name: (identifier) @name) @union

(union_template
  (union_decl
    name: (identifier) @name)) @union

(enum_decl
  name: (identifier) @name) @enum

(function_definition
  name: (identifier) @name) @function

(function_template
  (function_definition
    name: (identifier) @name)) @function

(alias_decl
  name: (identifier) @name) @typealias

(alias_template
  name: (identifier) @name) @typealias

(variable_decl
  name: (identifier) @name) @variable

(enum_constant
  name: (identifier) @name) @constant
