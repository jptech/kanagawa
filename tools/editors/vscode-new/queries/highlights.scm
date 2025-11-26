; Keywords
[
  "module"
  "import"
  "as"
  "export"
  "extern"
  "class"
  "struct"
  "union"
  "enum"
  "using"
  "template"
  "typename"
  "decltype"
  "static"
  "const"
  "inline"
  "noinline"
  "void"
  "auto"
  "bool"
  "int"
  "uint"
  "float32"
  "string"
  "if"
  "else"
  "switch"
  "case"
  "default"
  "for"
  "while"
  "do"
  "break"
  "continue"
  "return"
  "atomic"
  "barrier"
  "reorder"
  "public"
  "private"
  "protected"
] @keyword

; Built-in operators and functions
[
  "bitsizeof"
  "bytesizeof"
  "clog2"
  "cast"
  "static_cast"
  "reinterpret_cast"
  "checked_cast"
  "mux"
  "concat"
  "fan_out"
  "lutmul"
  "inspectable"
] @function.builtin

; Literals
(integer_literal) @number
(float_literal) @number
(boolean_literal) @boolean
(string_literal) @string
(string_content) @string
(escape_sequence) @string.escape
(string_interpolation) @embedded

; Comments
(comment) @comment

; Functions
(function_definition
  name: (identifier) @function.definition)

(function_template
  (function_definition
    name: (identifier) @function.definition))

(call_expression
  (identifier) @function.call)

(call_expression
  (member_expression
    (identifier) @function.call))

; Types
(class_decl
  name: (identifier) @type.definition)

(class_template
  (class_decl
    name: (identifier) @type.definition))

(struct_decl
  name: (identifier) @type.definition)

(struct_template
  (struct_decl
    name: (identifier) @type.definition))

(union_decl
  name: (identifier) @type.definition)

(union_template
  (union_decl
    name: (identifier) @type.definition))

(enum_decl
  name: (identifier) @type.definition)

(type_specifier
  (identifier) @type)

(typename_type
  (type_specifier
    (identifier) @type))

; Template parameters
(template_param
  (identifier) @type.parameter)

; Variables and Parameters
(variable_decl
  name: (identifier) @variable.definition)

(parameter
  name: (identifier) @parameter)

(enum_constant
  name: (identifier) @constant)

; Members
(member_expression
  (identifier) @property)

(designated_initializer
  (identifier) @property)

; Attributes
(attribute
  (identifier) @attribute)

; Modules
(module_decl
  name: (module_name) @namespace)

(import_decl
  path: (module_name) @namespace)

; Operators
[
  "+"
  "-"
  "*"
  "/"
  "%"
  "<<"
  ">>"
  "&"
  "|"
  "^"
  "~"
  "!"
  "&&"
  "||"
  "^^"
  "=="
  "!="
  "<"
  "<="
  ">"
  ">="
  "="
  "+="
  "-="
  "*="
  "/="
  "%="
  "<<="
  ">>="
  "&="
  "|="
  "^="
  "&&="
  "||="
  "^^="
  "++"
  "--"
] @operator

; Punctuation
[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

[
  ";"
  ","
  "."
  ":"
  "::"
  "->"
] @punctuation.delimiter

; Special
(scope_qualifier) @namespace
