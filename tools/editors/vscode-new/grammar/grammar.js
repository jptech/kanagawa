/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

/**
 * Tree-sitter grammar for Kanagawa Hardware HLS Language
 * 
 * This grammar is derived from:
 * - compiler/hs/lib/Language/Kanagawa/Parser.hs (reference implementation)
 * - overview.md (language specification)
 * - library/ (canonical code examples)
 */

module.exports = grammar({
  name: 'kanagawa',

  extras: $ => [
    /\s/,
    $.comment,
  ],

  word: $ => $.identifier,

  conflicts: $ => [
    // Type vs expression ambiguities (common in C-like languages)
    [$.type_specifier, $.call_expression],
    [$.type_specifier, $.template_instantiation],
    [$.type_specifier, $.primary_expression],
    [$.type_specifier, $.qualified_identifier],
    [$.template_args, $.binary_expression],
    [$._template_arg_expression, $.expression],
    [$._template_arg_expression, $.primary_expression],
    [$.primitive_type],
    [$.attribute, $.primary_expression],
    [$.call_expression],
    [$.function_type],
    [$.array_type],
    [$.while_statement],
    [$.for_statement],
    
    // Attributed types can look like expressions initially
    [$.attributed_type, $.call_expression],
    [$.attributed_type, $.parameter],
    
    // Template parameters vs template arguments
    [$.template_param, $.parameter],
    [$.template_param, $.primitive_type],
    
    // Initializer vs block and expression
    [$.initializer_list, $.block],
    [$.initializer_list, $.primary_expression],
    [$.designated_initializer, $.primary_expression],
    
    // Modifiers can appear in different contexts
    [$.decl_modifiers, $.func_modifiers],
    
    // Type composition ambiguities
    [$.modified_type, $.array_type],
    [$.array_type, $.function_type],
    [$.modified_type, $.for_statement],
    
    // Function types can appear in both type and expression contexts
    [$.type, $.primary_expression],
    
    // Declaration contexts
    [$.declaration, $.member_decl],
    [$.declaration, $.statement],
  ],

  rules: {
    source_file: $ => repeat($._top_level),

    _top_level: $ => choice(
      $.module_decl,
      $.import_decl,
      $.declaration,
    ),

    // ============================================================================
    // Comments
    // ============================================================================

    comment: $ => token(choice(
      // Documentation comments (must come before regular comments for priority)
      seq('//|', /.*/),
      seq('//<', /.*/),
      // Regular comments
      seq('//', /.*/),
      // Nested block comments
      seq(
        '/*',
        repeat(choice(
          /[^*]/,
          /\*[^/]/
        )),
        '*/'
      )
    )),

    // ============================================================================
    // Module System
    // ============================================================================

    module_decl: $ => prec.right(seq(
      'module',
      field('name', $.module_name),
      optional($.module_exports),
      repeat($.declaration)
    )),

    module_name: $ => choice(
      '.cmdargs',
      '.options',
      sepBy1(token.immediate('.'), $.module_identifier_part)
    ),

    module_identifier_part: $ => /[a-zA-Z_][a-zA-Z0-9_\-]*/,

    module_exports: $ => seq(
      '{',
      commaSep(choice(
        $.identifier,
        $.module_reference,
        $.module_diff
      )),
      '}'
    ),

    module_reference: $ => seq('module', $.module_name),
    module_diff: $ => seq('module', $.module_name, '\\', $.module_name),

    import_decl: $ => seq(
      'import',
      field('path', $.module_name),
      optional(seq('as', field('alias', $.identifier)))
    ),

    // ============================================================================
    // Declarations
    // ============================================================================

    declaration: $ => choice(
      $.function_definition,
      $.function_template,
      $.class_decl,
      $.class_template,
      $.struct_decl,
      $.struct_template,
      $.union_decl,
      $.union_template,
      $.enum_decl,
      $.alias_decl,
      $.alias_template,
      $.extern_decl,
      $.export_decl,
      $.static_assert,
      seq($.variable_decl, ';'),
      $.static_if,
    ),

    // ----------------------------------------------------------------------------
    // Variables
    // ----------------------------------------------------------------------------

    variable_decl: $ => prec(1, seq(
      optional($.attributes),
      optional(field('modifiers', $.decl_modifiers)),
      field('type', $.type),
      field('name', $.identifier),
      optional(seq('=', field('initializer', choice($.expression, $.initializer))))
    )),

    decl_modifiers: $ => repeat1(choice('static', 'inline', 'noinline')),

    // ----------------------------------------------------------------------------
    // Functions
    // ----------------------------------------------------------------------------

    function_definition: $ => seq(
      optional($.attributes),
      optional(field('modifiers', $.func_modifiers)),
      field('return_type', $.type),
      field('name', $.identifier),
      field('parameters', $.parameter_list),
      choice($.block, ';')
    ),

    func_modifiers: $ => repeat1(choice('static', 'inline', 'noinline')),

    function_template: $ => seq(
      $.template_params,
      $.function_definition
    ),

    parameter_list: $ => seq(
      '(',
      commaSep($.parameter),
      ')'
    ),

    parameter: $ => seq(
      optional($.attributes),
      field('type', $.type),
      optional(field('name', $.identifier)),
      optional(seq('=', field('default', $.expression)))
    ),

    // ----------------------------------------------------------------------------
    // Classes, Structs, Unions
    // ----------------------------------------------------------------------------

    class_decl: $ => prec.right(seq(
      'class',
      field('name', $.identifier),
      optional(seq('{', repeat($.member_decl), '}'))
    )),

    class_template: $ => seq(
      $.template_params,
      $.class_decl
    ),

    struct_decl: $ => prec.right(seq(
      'struct',
      field('name', $.identifier),
      optional(seq('{', repeat($.member_decl), '}'))
    )),

    struct_template: $ => seq(
      $.template_params,
      $.struct_decl
    ),

    union_decl: $ => prec.right(seq(
      'union',
      field('name', $.identifier),
      optional(seq('{', repeat($.member_decl), '}'))
    )),

    union_template: $ => seq(
      $.template_params,
      $.union_decl
    ),

    member_decl: $ => choice(
      seq(choice('private', 'public', 'protected'), ':'),
      $.function_definition,
      $.function_template,
      seq($.variable_decl, ';'),
      $.default_initialization,
      $.static_if,
      $.declaration,
    ),

    default_initialization: $ => seq(
      'default',
      '=',
      $.expression,
      ';'
    ),

    // ----------------------------------------------------------------------------
    // Enums
    // ----------------------------------------------------------------------------

    enum_decl: $ => seq(
      'enum',
      field('name', $.identifier),
      ':',
      field('base_type', $.type),
      '{',
      commaSep($.enum_constant),
      optional(','),
      '}'
    ),

    enum_constant: $ => seq(
      field('name', $.identifier),
      optional(seq('=', field('value', $.expression)))
    ),

    // ----------------------------------------------------------------------------
    // Type Aliases
    // ----------------------------------------------------------------------------

    alias_decl: $ => seq(
      'using',
      field('name', $.identifier),
      '=',
      field('type', $.type),
      ';'
    ),

    alias_template: $ => seq(
      $.template_params,
      'using',
      field('name', $.identifier),
      '=',
      field('type', $.type),
      ';'
    ),

    // ----------------------------------------------------------------------------
    // Extern and Export
    // ----------------------------------------------------------------------------

    extern_decl: $ => prec(2, seq(
      'extern',
      choice(
        $.class_decl,
        seq(
          optional($.attributes),
          field('type', $.type),
          field('name', $.identifier),
          ';'
        ),
        seq(
          optional($.attributes),
          field('return_type', $.type),
          field('name', $.identifier),
          field('parameters', $.parameter_list),
          ';'
        )
      )
    )),

    export_decl: $ => seq(
      'export',
      choice(
        $.class_decl,
        $.function_definition,
        seq($.type, ';')
      )
    ),

    // ----------------------------------------------------------------------------
    // Static Assert & Static If/For
    // ----------------------------------------------------------------------------

    static_assert: $ => seq(
      'static',
      /assert/,
      '(',
      $.expression,
      optional(seq(',', $.string_literal)),
      ')',
      ';'
    ),

    static_if: $ => prec.right(seq(
      'static',
      'if',
      '(',
      $.expression,
      ')',
      choice($.statement, $.declaration),
      optional(seq('else', choice($.statement, $.declaration)))
    )),

    static_for: $ => seq(
      'static',
      'for',
      '(',
      'const',
      $.type,
      $.identifier,
      ':',
      $.expression,
      ')',
      choice($.statement, $.declaration)
    ),

    // ============================================================================
    // Types
    // ============================================================================

    type: $ => choice(
      $.primitive_type,
      $.modified_type,
      $.type_specifier,
      $.array_type,
      $.function_type,
      $.attributed_type,
      $.typename_type,
      $.decltype_type,
    ),

    primitive_type: $ => choice(
      'void',
      'auto',
      'string',
      'bool',
      'float32',
      seq('int', optional(choice(seq('<', $.expression, '>'), $.integer_suffix))),
      seq('uint', optional(choice(seq('<', $.expression, '>'), $.integer_suffix))),
    ),

    modified_type: $ => seq('const', $.type),

    type_specifier: $ => prec.left(seq(
      optional($.scope_qualifier),
      $.identifier,
      optional($.template_args)
    )),

    array_type: $ => prec.right(seq(
      optional($.attributes), // Using general attributes instead of memory_attributes
      $.type,
      '[',
      $.expression,
      ']'
    )),

    function_type: $ => seq(
      optional($.attributes),
      '(',
      commaSep($.parameter),
      ')',
      '->',
      $.type
    ),

    attributed_type: $ => prec.right(seq(
      $.attributes,
      $.type
    )),

    typename_type: $ => seq('typename', $.type_specifier),

    decltype_type: $ => seq('decltype', '(', $.expression, ')'),

    scope_qualifier: $ => prec.left(repeat1(seq($.identifier, token.immediate('::')))),

    integer_suffix: $ => /[iu]\d+/,

    // ============================================================================
    // Attributes
    // ============================================================================

    attributes: $ => seq(
      '[[',
      commaSep1($.attribute),
      ']]'
    ),

    attribute: $ => choice(
      // Simple attributes
      $.identifier,
      // Attributes with arguments
      seq(
        $.identifier,
        '(',
        choice(
          commaSep1($.expression),
          $.identifier, // For Ecc(mode), etc.
        ),
        ')'
      )
    ),

    memory_attributes: $ => seq(
      '[[',
      commaSep1(choice(
        'Memory',
        'DualPort',
        'QuadPort',
        'BRAM',
        'LUTRAM',
        'NonReplicated',
        'non_replicated',
        'Initialize',
        seq('Ecc', '(', $.identifier, ')'),
        $.attribute,
      )),
      ']]'
    ),

    // ============================================================================
    // Template Parameters & Arguments
    // ============================================================================

    template_params: $ => seq(
      'template',
      '<',
      commaSep1($.template_param),
      '>'
    ),

    template_param: $ => choice(
      // typename T
      seq(
        'typename',
        $.identifier,
        optional(seq('=', $.type))
      ),
      // auto N
      seq(
        'auto',
        $.identifier,
        optional(seq('=', $._template_arg_expression))
      ),
      // Type name
      seq(
        $.type,
        $.identifier,
        optional(seq('=', $._template_arg_expression))
      ),
      // Template template parameter: template <typename> typename TT
      seq(
        'template',
        '<',
        commaSep1($.template_param),
        '>',
        'typename',
        $.identifier
      )
    ),

    template_args: $ => seq(
      token.immediate('<'),
      commaSep1($._template_arg_expression),
      token.immediate('>')
    ),

    // Special expression context that disallows < and > at top level to avoid ambiguity
    _template_arg_expression: $ => choice(
      $.type,
      $.primary_expression,
      $.unary_expression,
      $.member_expression,
      $.call_expression,
      $.subscript_expression,
      $.cast_expression,
      // Binary expressions excluding comparison operators
      prec.left(13, seq($._template_arg_expression, choice('*', '/', '%'), $._template_arg_expression)),
      prec.left(12, seq($._template_arg_expression, choice('+', '-'), $._template_arg_expression)),
      prec.left(9, seq($._template_arg_expression, choice('==', '!='), $._template_arg_expression)),
      prec.left(8, seq($._template_arg_expression, '&', $._template_arg_expression)),
      prec.left(7, seq($._template_arg_expression, '^', $._template_arg_expression)),
      prec.left(6, seq($._template_arg_expression, '|', $._template_arg_expression)),
      prec.left(5, seq($._template_arg_expression, '&&', $._template_arg_expression)),
      prec.left(4, seq($._template_arg_expression, '^^', $._template_arg_expression)),
      prec.left(3, seq($._template_arg_expression, '||', $._template_arg_expression)),
      seq('(', $.expression, ')'),
    ),

    // ============================================================================
    // Statements
    // ============================================================================

    block: $ => seq('{', repeat(choice($.statement, $.declaration)), '}'),

    statement: $ => choice(
      $.empty_statement,
      $.expression_statement,
      $.block,
      $.if_statement,
      $.switch_statement,
      $.for_statement,
      $.while_statement,
      $.do_while_statement,
      $.atomic_do_while_statement,
      $.atomic_statement,
      $.reorder_statement,
      $.barrier_statement,
      $.return_statement,
      $.break_statement,
      $.continue_statement,
      $.static_if,
      $.static_for,
    ),

    empty_statement: $ => ';',

    expression_statement: $ => seq($.expression, ';'),

    return_statement: $ => seq('return', optional($.expression), ';'),

    break_statement: $ => seq('break', ';'),

    continue_statement: $ => seq('continue', ';'),

    barrier_statement: $ => seq('barrier', ';'),

    reorder_statement: $ => seq('reorder', $.statement),

    atomic_statement: $ => seq(
      'atomic',
      optional($.attributes),
      $.statement
    ),

    // Critical: atomic do while is a SINGLE construct (higher precedence than atomic statement)
    atomic_do_while_statement: $ => prec(1, seq(
      'atomic',
      optional($.attributes),
      'do',
      $.statement,
      'while',
      '(',
      $.expression,
      ')',
      ';'
    )),

    if_statement: $ => prec.right(seq(
      'if',
      '(',
      $.expression,
      ')',
      $.statement,
      optional(seq('else', $.statement))
    )),

    switch_statement: $ => seq(
      'switch',
      '(',
      $.expression,
      ')',
      '{',
      repeat(choice($.case_clause, $.default_clause)),
      '}'
    ),

    case_clause: $ => seq(
      'case',
      $.expression,
      ':',
      repeat($.statement)
    ),

    default_clause: $ => seq(
      'default',
      ':',
      repeat($.statement)
    ),

    for_statement: $ => seq(
      optional($.attributes),
      'for',
      '(',
      choice(
        // Range-based for: for (const T i : expr)
        seq(
          'const',
          $.type,
          $.identifier,
          ':',
          $.expression
        ),
        // Traditional for: for (init; cond; update)
        seq(
          choice($.variable_decl, $.expression, $.empty_statement),
          ';',
          optional($.expression),
          ';',
          optional($.expression)
        )
      ),
      ')',
      $.statement
    ),

    while_statement: $ => seq(
      optional($.attributes),
      'while',
      '(',
      $.expression,
      ')',
      $.statement
    ),

    do_while_statement: $ => seq(
      optional($.attributes),
      'do',
      $.statement,
      'while',
      '(',
      $.expression,
      ')',
      ';'
    ),

    // ============================================================================
    // Expressions
    // ============================================================================

    expression: $ => choice(
      $.primary_expression,
      $.binary_expression,
      $.unary_expression,
      $.update_expression,
      $.assignment_expression,
      $.ternary_expression,
      $.member_expression,
      $.call_expression,
      $.subscript_expression,
      $.cast_expression,
      $.lambda_expression,
      $.template_instantiation,
    ),

    primary_expression: $ => choice(
      $.identifier,
      $.qualified_identifier,
      $.literal,
      $.initializer,
      $.function_type,
      seq('(', $.expression, ')'),
    ),

    // ----------------------------------------------------------------------------
    // Binary & Unary Operations (with correct precedence)
    // ----------------------------------------------------------------------------

    binary_expression: $ => choice(
      // Precedence 13: Multiplicative
      prec.left(13, seq($.expression, choice('*', '/', '%'), $.expression)),
      
      // Precedence 12: Additive
      prec.left(12, seq($.expression, choice('+', '-'), $.expression)),
      
      // Precedence 11: Shift
      prec.left(11, seq($.expression, choice('<<', '>>'), $.expression)),
      
      // Precedence 10: Relational
      prec.left(10, seq($.expression, choice('<', '<=', '>', '>='), $.expression)),
      
      // Precedence 9: Equality
      prec.left(9, seq($.expression, choice('==', '!='), $.expression)),
      
      // Precedence 8: Bitwise AND
      prec.left(8, seq($.expression, '&', $.expression)),
      
      // Precedence 7: Bitwise XOR
      prec.left(7, seq($.expression, '^', $.expression)),
      
      // Precedence 6: Bitwise OR
      prec.left(6, seq($.expression, '|', $.expression)),
      
      // Precedence 5: Logical AND
      prec.left(5, seq($.expression, '&&', $.expression)),
      
      // Precedence 4: Logical XOR
      prec.left(4, seq($.expression, '^^', $.expression)),
      
      // Precedence 3: Logical OR
      prec.left(3, seq($.expression, '||', $.expression)),
    ),

    unary_expression: $ => choice(
      // Precedence 16: Unary minus
      prec(16, seq('-', $.expression)),
      
      // Precedence 15: Logical/bitwise NOT
      prec(15, seq(choice('!', '~'), $.expression)),
      
      // Precedence 14: sizeof-like operators
      prec(14, seq(
        choice('bitsizeof', 'bytesizeof', 'clog2'),
        choice(
          $.expression,
          seq('typename', $.type_specifier),
          $.type
        )
      )),
    ),

    // Precedence 17: Postfix/prefix increment/decrement
    update_expression: $ => choice(
      prec.right(17, seq(choice('++', '--'), $.expression)),
      prec.left(17, seq($.expression, choice('++', '--'))),
    ),

    // Precedence 1: Assignment operators
    assignment_expression: $ => prec.right(1, seq(
      $.expression,
      choice(
        '=',
        '+=', '-=', '*=', '/=', '%=',
        '<<=', '>>=',
        '&=', '|=', '^=',
        '&&=', '||=', '^^='
      ),
      $.expression
    )),

    // Precedence 2: Ternary conditional
    ternary_expression: $ => prec.right(2, seq(
      $.expression,
      '?',
      $.expression,
      ':',
      $.expression
    )),

    // ----------------------------------------------------------------------------
    // Member Access, Calls, Subscripts
    // ----------------------------------------------------------------------------

    member_expression: $ => prec.left(18, seq(
      $.expression,
      token.immediate('.'),
      $.identifier,
      // Support template member access: obj.template method<T>()
      optional(seq(token.immediate('template'), $.template_args))
    )),

    call_expression: $ => prec.left(18, seq(
      optional($.attributes),
      $.expression,
      $.argument_list
    )),

    argument_list: $ => seq(
      token.immediate('('),
      commaSep($.expression),
      ')'
    ),

    subscript_expression: $ => prec.left(18, seq(
      $.expression,
      token.immediate('['),
      $.expression,
      ']'
    )),

    // ----------------------------------------------------------------------------
    // Casts
    // ----------------------------------------------------------------------------

    cast_expression: $ => prec(18, choice(
      seq('cast', optional(seq('<', $.type, '>')), '(', $.expression, ')'),
      seq('static_cast', optional(seq('<', $.type, '>')), '(', $.expression, ')'),
      seq('reinterpret_cast', optional(seq('<', $.type, '>')), '(', $.expression, ')'),
      seq('checked_cast', optional(seq('<', $.type, '>')), '(', $.expression, ')'),
    )),

    // ----------------------------------------------------------------------------
    // Built-in Functions
    // ----------------------------------------------------------------------------

    builtin_function: $ => choice(
      seq('mux', '(', $.expression, ',', commaSep1($.expression), ')'),
      seq('concat', '(', commaSep1($.expression), ')'),
      seq('fan_out', '<', $.expression, '>', '(', $.expression, ')'),
      seq('lutmul', '(', $.expression, ',', $.expression, ')'),
      seq(/assert/, '(', $.expression, ')'),
    ),

    // ----------------------------------------------------------------------------
    // Templates & Qualified Names
    // ----------------------------------------------------------------------------

    template_instantiation: $ => prec(18, seq(
      optional($.scope_qualifier),
      $.identifier,
      $.template_args
    )),

    qualified_identifier: $ => seq(
      $.scope_qualifier,
      $.identifier
    ),

    // ----------------------------------------------------------------------------
    // Lambda Expressions
    // ----------------------------------------------------------------------------

    lambda_expression: $ => seq(
      '[',
      commaSep($.capture),
      ']',
      optional(seq('(', commaSep($.parameter), ')')),
      optional(seq('->', $.type)),
      $.block
    ),

    capture: $ => choice(
      $.identifier,
      seq('&', $.identifier),
      seq('this'),
      seq($.identifier, '=', $.expression),
    ),

    // ----------------------------------------------------------------------------
    // Initializers
    // ----------------------------------------------------------------------------

    initializer: $ => choice(
      $.initializer_list,
      $.designated_initializer_list,
    ),

    initializer_list: $ => seq(
      '{',
      commaSep(choice($.expression, $.initializer)),
      optional(','),
      '}'
    ),

    designated_initializer_list: $ => seq(
      '{',
      commaSep1($.designated_initializer),
      optional(','),
      '}'
    ),

    designated_initializer: $ => seq(
      '.',
      $.identifier,
      '=',
      choice($.expression, $.initializer)
    ),

    // ============================================================================
    // Literals
    // ============================================================================

    literal: $ => choice(
      $.integer_literal,
      $.float_literal,
      $.boolean_literal,
      $.string_literal,
    ),

    integer_literal: $ => token(seq(
      choice(
        /0[bB][01](_?[01])*/,                    // Binary
        /0[oO][0-7](_?[0-7])*/,                  // Octal
        /0[xX][0-9a-fA-F](_?[0-9a-fA-F])*/,      // Hexadecimal
        /[0-9](_?[0-9])*/                        // Decimal
      ),
      optional(seq(
        optional('_'),
        choice(/i\d+/, /u\d+/)                   // Suffix: i32, u16, etc.
      ))
    )),

    float_literal: $ => token(choice(
      /[0-9](_?[0-9])*\.[0-9](_?[0-9])*([eE][+-]?[0-9](_?[0-9])*)?/,
      /[0-9](_?[0-9])*[eE][+-]?[0-9](_?[0-9])*/,
    )),

    boolean_literal: $ => choice('true', 'false'),

    // String literals with interpolation support
    string_literal: $ => seq(
      '"',
      repeat(choice(
        $.string_content,
        $.escape_sequence,
        $.string_interpolation,
      )),
      '"'
    ),

    string_content: $ => token.immediate(prec(1, /[^"\\{]+/)),

    escape_sequence: $ => token.immediate(seq(
      '\\',
      choice(
        /[\\'"nrt]/,
        /x[0-9a-fA-F]{2}/,
        /u[0-9a-fA-F]{4}/,
        /U[0-9a-fA-F]{8}/,
      )
    )),

    string_interpolation: $ => seq(
      token.immediate('{'),
      $.expression,
      optional(token.immediate('=')),
      optional(seq(
        token.immediate(','),
        optional(token.immediate(/[+-]?[0-9]+/))  // alignment
      )),
      optional(seq(
        token.immediate(':'),
        token.immediate(/[bodxX]/),               // format specifier
        optional(token.immediate(/[0-9]+/))       // precision
      )),
      token.immediate('}')
    ),

    // ============================================================================
    // Identifiers
    // ============================================================================

    identifier: $ => /[a-zA-Z_][a-zA-Z0-9_]*/,
  }
});

// ============================================================================
// Helper Functions
// ============================================================================

function commaSep(rule) {
  return optional(commaSep1(rule));
}

function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)));
}

function sepBy1(sep, rule) {
  return seq(rule, repeat(seq(sep, rule)));
}
