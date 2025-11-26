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

  word: $ => $._word,

  conflicts: $ => [
    // Type vs expression ambiguities (common in C-like languages)
    [$.type_specifier, $.call_expression],
    [$.type_specifier, $.template_instantiation],
    [$.type_specifier, $._primary_expression],
    [$._simple_type_specifier, $._primary_expression],
    [$._templated_type_specifier, $.template_instantiation],
    [$.type_specifier, $.qualified_identifier],
    [$._simple_type_specifier, $.qualified_identifier],
    [$._templated_type_specifier, $.qualified_identifier],
    [$.template_instantiation, $.qualified_identifier],
    [$._templated_type_specifier, $.template_instantiation, $.qualified_identifier],
    [$.binary_expression, $.assignment_expression],
    [$.binary_expression, $.assignment_expression, $.ternary_expression],
    [$.template_args, $.binary_expression],
    [$._template_arg_expression, $._expression],
    [$._template_arg_expression, $._primary_expression],
    [$.primitive_type],
    [$.attribute, $._primary_expression],
    [$.call_expression],
    [$.function_type],
    [$.array_type],
    
    // Attributed types can look like expressions initially
    [$.attributed_type, $.call_expression],
    [$.attributed_type, $.parameter],
    
    // Template parameters vs template arguments
    [$.template_param, $.parameter],
    [$.template_param, $.primitive_type],
    
    // Initializer vs block and expression
    [$.initializer_list, $.block],
    [$.initializer_list, $._primary_expression],
    [$.designated_initializer, $._primary_expression],
    
    // Modifiers can appear in different contexts
    [$.decl_modifiers, $.func_modifiers],
    
    // Type composition ambiguities
    [$.modified_type, $.array_type],
    [$.array_type, $.function_type],
    [$.modified_type, $.range_for_statement],
    
    // Variable declarations vs expressions (e.g., "optional<T>[N] x" vs subscript)
    [$.variable_decl, $.expression_statement],
    [$.variable_decl, $._primary_expression],
    [$.variable_decl],
    [$.array_type, $.subscript_expression],
    
    // Function types can appear in both type and expression contexts
    [$._type, $._primary_expression],
    
    // Declaration contexts
    [$.declaration, $.member_decl],
    [$.declaration, $._statement],
    [$.declaration, $._statement_body],
    
    // static can be a modifier or start static_assert
    [$.decl_modifiers, $.func_modifiers, $.static_assert],

    // Attribute categories share the same prefix
    [$.attributes, $.memory_attributes],
    [$.call_attributes, $.loop_attributes],

    [$.template_instantiation, $.binary_expression],
    [$._templated_type_specifier, $.binary_expression],
    [$._templated_type_specifier, $._primary_expression],
    [$._simple_type_specifier, $._templated_type_specifier, $._primary_expression],
    [$._simple_type_specifier, $._templated_type_specifier],
    [$._simple_type_specifier, $._templated_type_specifier, $.qualified_identifier],
    [$.scope_qualifier, $._primary_expression, $.template_instantiation],
    [$._primary_expression, $.template_instantiation],
    [$.scope_qualifier, $.qualified_identifier],
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

    variable_decl: $ => seq(
      optional($.attributes),
      optional(field('modifiers', $.decl_modifiers)),
      field('type', $._type),
      field('name', $.identifier),
      optional(seq('=', field('initializer', choice($._expression, $.initializer))))
    ),

    decl_modifiers: $ => repeat1(choice('static', 'inline', 'noinline')),

    // ----------------------------------------------------------------------------
    // Functions
    // ----------------------------------------------------------------------------

    function_definition: $ => seq(
      optional($.attributes),
      optional(field('modifiers', $.func_modifiers)),
      field('return_type', $._type),
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
      field('type', $._type),
      optional(field('name', $.identifier)),
      optional(seq('=', field('default', $._expression)))
    ),

    // ----------------------------------------------------------------------------
    // Classes, Structs, Unions
    // ----------------------------------------------------------------------------

    class_decl: $ => prec.right(seq(
      'class',
      field('name', $.identifier),
      optional(seq('{', repeat($.member_decl), '}')),
      optional(';')
    )),

    class_template: $ => seq(
      $.template_params,
      $.class_decl
    ),

    struct_decl: $ => prec.right(seq(
      'struct',
      field('name', $.identifier),
      optional(seq('{', repeat($.member_decl), '}')),
      optional(';')
    )),

    struct_template: $ => seq(
      $.template_params,
      $.struct_decl
    ),

    union_decl: $ => prec.right(seq(
      'union',
      field('name', $.identifier),
      optional(seq('{', repeat($.member_decl), '}')),
      optional(';')
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
      $.inspectable_decl,  // Built-in inspectable declaration
      $.default_initialization,
      $.static_if,
      $.declaration,
    ),

    // Built-in inspectable declaration for exposing variables for runtime inspection
    inspectable_decl: $ => seq(
      'inspectable',
      '(',
      field('variable', $._expression),
      ',',
      field('description', $.string_literal),
      ')',
      ';'
    ),

    default_initialization: $ => seq(
      'default',
      '=',
      $._expression,
      ';'
    ),

    // ----------------------------------------------------------------------------
    // Enums
    // ----------------------------------------------------------------------------

    enum_decl: $ => prec.right(seq(
      'enum',
      field('name', $.identifier),
      ':',
      field('base_type', $._type),
      '{',
      commaSep($.enum_constant),
      optional(','),
      '}',
      optional(';')
    )),

    enum_constant: $ => seq(
      field('name', $.identifier),
      optional(seq('=', field('value', $._expression)))
    ),

    // ----------------------------------------------------------------------------
    // Type Aliases
    // ----------------------------------------------------------------------------

    alias_decl: $ => seq(
      'using',
      field('name', $.identifier),
      '=',
      field('type', $._type),
      ';'
    ),

    alias_template: $ => seq(
      $.template_params,
      'using',
      field('name', $.identifier),
      '=',
      field('type', $._type),
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
          field('type', $._type),
          field('name', $.identifier),
          ';'
        ),
        seq(
          optional($.attributes),
          field('return_type', $._type),
          field('name', $.identifier),
          field('parameters', $.parameter_list),
          ';'
        )
      )
    )),

    export_decl: $ => seq(
      optional($.attributes),
      'export',
      choice(
        $.class_decl,
        $.function_definition,
        seq($._type, ';')
      )
    ),

    // ----------------------------------------------------------------------------
    // Static Assert & Static If/For
    // ----------------------------------------------------------------------------

    static_assert: $ => seq(
      choice(
        token(prec(10, seq('static', /\s+/, 'assert'))),
        'static_assert'
      ),
      '(',
      $._expression,
      optional(seq(',', $.string_literal)),
      ')',
      ';'
    ),

    static_if: $ => prec.right(seq(
      'static',
      'if',
      '(',
      $._expression,
      ')',
      choice($._statement, $.declaration),
      optional(seq('else', choice($._statement, $.declaration)))
    )),

    static_for: $ => seq(
      'static',
      'for',
      '(',
      'const',
      $._type,
      $.identifier,
      ':',
      $._expression,
      ')',
      choice($._statement, $.declaration)
    ),

    // ============================================================================
    // Types
    // ============================================================================

    _type: $ => choice(
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
      seq('int', optional(choice(
        seq(token.immediate('<'), $._template_arg_expression, token.immediate('>')),
        $.integer_suffix
      ))),
      seq('uint', optional(choice(
        seq(token.immediate('<'), $._template_arg_expression, token.immediate('>')),
        $.integer_suffix
      ))),
    ),

    modified_type: $ => seq('const', $._type),

    type_specifier: $ => choice(
      $._simple_type_specifier,
      $._templated_type_specifier
    ),

    _simple_type_specifier: $ => seq(
      optional($.scope_qualifier),
      $.identifier
    ),

    _templated_type_specifier: $ => prec.dynamic(1, seq(
      optional($.scope_qualifier),
      $.identifier,
      choice(
        seq(token.immediate('<'), commaSep1($._template_arg_expression), '>'),
        $.template_args
      )
    )),

    array_type: $ => prec.dynamic(20, prec.right(18, seq(
      optional($.memory_attributes),
      $._type,
      repeat1(seq('[', $._expression, ']'))
    ))),

    function_type: $ => seq(
      optional($.attributes),
      '(',
      commaSep($.parameter),
      ')',
      '->',
      $._type
    ),

    attributed_type: $ => prec.right(seq(
      $.attributes,
      $._type
    )),

    typename_type: $ => seq('typename', $.type_specifier),

    decltype_type: $ => seq('decltype', '(', $._expression, ')'),

    scope_qualifier: $ => prec.left(repeat1(seq(
      optional('template'),
      $.identifier,
      optional(seq(token.immediate('<'), commaSep1($._template_arg_expression), '>')),
      token.immediate('::')
    ))),

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
          commaSep1($._expression),
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

    call_attributes: $ => seq(
      '[[',
      commaSep1(choice(
        seq('call_rate', '(', $._expression, ')'),
        seq('fifo_depth', '(', $._expression, ')'),
        seq('transaction_size', '(', $._expression, ')')
      )),
      ']]'
    ),

    statement_attributes: $ => seq(
      '[[',
      commaSep1(seq('schedule', '(', $._expression, ')')),
      ']]'
    ),

    loop_attributes: $ => seq(
      '[[',
      commaSep1(choice(
        'unordered',
        'reorder_by_looping',
        seq('fifo_depth', '(', $._expression, ')')
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
        optional(seq('=', $._type))
      ),
      // auto N
      seq(
        'auto',
        $.identifier,
        optional(seq('=', $._template_arg_expression))
      ),
      // Typed non-type parameter
      seq(
        $._type,
        $.identifier,
        optional(seq('=', $._template_arg_expression))
      ),
      // Template template parameter: template <typename> typename TT = template_id
      seq(
        'template',
        '<',
        commaSep1($.template_param_kind),
        '>',
        'typename',
        $.identifier,
        optional(seq('=', $.type_specifier))
      )
    ),

    template_param_kind: $ => choice(
      'typename',
      $._type
    ),

    template_args: $ => seq(
      '<',
      commaSep1($._template_arg_expression),
      '>'
    ),

    // Special expression context that disallows < and > at top level to avoid ambiguity
    _template_arg_expression: $ => choice(
      $._type,
      $._primary_expression,
      $.unary_expression,
      $.member_expression,
      $.call_expression,
      $.subscript_expression,
      // $.cast_expression,
      $._template_arg_ternary_expression,
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
      seq('(', $._expression, ')'),
    ),

    _template_arg_ternary_expression: $ => prec.right(2, seq(
      $._template_arg_expression,
      '?',
      $._template_arg_expression,
      ':',
      $._template_arg_expression
    )),

    // ============================================================================
    // Statements
    // ============================================================================

    block: $ => seq('{', repeat(choice(
      prec(1, $.declaration),
      $._statement
    )), '}'),

    _statement: $ => choice(
      $.annotated_statement,
      $._statement_body
    ),

    _statement_body: $ => choice(
      $.empty_statement,
      seq($.variable_decl, ';'),  // Explicitly allow variable declarations as statements
      $.expression_statement,
      $.block,
      $.if_statement,
      $.switch_statement,
      $.range_for_statement,
      $.do_while_statement,
      $.atomic_statement,
      $.reorder_statement,
      $.barrier_statement,
      $.return_statement,
      $.break_statement,
      $.continue_statement,
      $.static_if,
      $.static_for,
    ),

    annotated_statement: $ => seq($.statement_attributes, $._statement_body),

    empty_statement: $ => ';',

    expression_statement: $ => seq($._expression, ';'),

    return_statement: $ => seq('return', optional($._expression), ';'),

    break_statement: $ => seq('break', ';'),

    continue_statement: $ => seq('continue', ';'),

    barrier_statement: $ => seq('barrier', ';'),

    reorder_statement: $ => seq('reorder', $._statement),

    atomic_statement: $ => seq('atomic', $._statement),

    if_statement: $ => prec.right(seq(
      'if',
      '(',
      $._expression,
      ')',
      $._statement,
      optional(seq('else', $._statement))
    )),

    switch_statement: $ => seq(
      'switch',
      '(',
      $._expression,
      ')',
      '{',
      repeat(choice($.case_clause, $.default_clause)),
      '}'
    ),

    case_clause: $ => seq(
      'case',
      $._expression,
      ':',
      repeat($._statement)
    ),

    default_clause: $ => seq(
      'default',
      ':',
      repeat($._statement)
    ),

    range_for_statement: $ => seq(
      optional($.loop_attributes),
      'for',
      '(',
      'const',
      $._type,
      $.identifier,
      ':',
      $._expression,
      ')',
      $._statement
    ),

    do_while_statement: $ => prec.right(seq(
      optional($.loop_attributes),
      'do',
      $._statement,
      'while',
      '(',
      $._expression,
      ')',
      optional(';')
    )),

    // ============================================================================
    // Expressions
    // ============================================================================

    _expression: $ => choice(
      $._primary_expression,
      $.binary_expression,
      $.unary_expression,
      $.update_expression,
      $.assignment_expression,
      $.ternary_expression,
      $.member_expression,
      $.call_expression,
      $.subscript_expression,
      // $.cast_expression,
      $.lambda_expression,
      $.template_instantiation,
    ),

    _primary_expression: $ => prec.dynamic(2, choice(
      $.identifier,
      $.qualified_identifier,
      $.literal,
      $.initializer,
      $.function_type,
      seq('(', $._expression, ')'),
      $.cast_operator,
    )),

    // ----------------------------------------------------------------------------
    // Binary & Unary Operations (with correct precedence)
    // ----------------------------------------------------------------------------

    binary_expression: $ => choice(
      // Precedence 13: Multiplicative
      prec.left(13, seq($._expression, choice('*', '/', '%'), $._expression)),
      
      // Precedence 12: Additive
      prec.left(12, seq($._expression, choice('+', '-'), $._expression)),
      
      // Precedence 11: Shift
      prec.left(11, seq($._expression, choice('<<', alias(seq('>', token.immediate('>')), '>>')), $._expression)),
      
      // Precedence 10: Relational
      // Precedence 10: Relational
      prec.dynamic(1, prec.left(10, seq($._expression, choice('<', '<=', '>', '>='), $._expression))),
      
      // Precedence 9: Equality
      prec.left(9, seq($._expression, choice('==', '!='), $._expression)),
      
      // Precedence 8: Bitwise AND
      prec.left(8, seq($._expression, '&', $._expression)),
      
      // Precedence 7: Bitwise XOR
      prec.left(7, seq($._expression, '^', $._expression)),
      
      // Precedence 6: Bitwise OR
      prec.left(6, seq($._expression, '|', $._expression)),
      
      // Precedence 5: Logical AND
      prec.left(5, seq($._expression, '&&', $._expression)),
      
      // Precedence 4: Logical XOR
      prec.left(4, seq($._expression, '^^', $._expression)),
      
      // Precedence 3: Logical OR
      prec.left(3, seq($._expression, '||', $._expression)),
    ),

    unary_expression: $ => choice(
      // Precedence 16: Unary minus
      prec(16, seq('-', $._expression)),
      
      // Precedence 15: Logical/bitwise NOT
      prec(15, seq(choice('!', '~'), $._expression)),
      
      // Precedence 14: sizeof-like operators
      prec(14, seq(
        choice('bitsizeof', 'bytesizeof', 'clog2'),
        choice(
          $._expression,
          seq('typename', $.type_specifier),
          $._type
        )
      )),
    ),

    // Precedence 17: Postfix/prefix increment/decrement
    update_expression: $ => choice(
      prec.right(17, seq(choice('++', '--'), $._expression)),
      prec.left(17, seq($._expression, choice('++', '--'))),
    ),

    // Precedence 1: Assignment operators
    assignment_expression: $ => prec.right(1, seq(
      $._expression,
      choice(
        '=',
        '+=', '-=', '*=', '/=', '%=',
        '<<=', alias(seq('>', token.immediate('>'), token.immediate('=')), '>>='),
        '&=', '|=', '^=',
        '&&=', '||=', '^^='
      ),
      $._expression
    )),

    // Precedence 2: Ternary conditional
    ternary_expression: $ => prec.right(2, seq(
      $._expression,
      '?',
      $._expression,
      ':',
      $._expression
    )),

    // ----------------------------------------------------------------------------
    // Member Access, Calls, Subscripts
    // ----------------------------------------------------------------------------

    member_expression: $ => prec.left(18, seq(
      $._expression,
      token.immediate('.'),
      optional('template'),
      $.identifier,
      optional(choice(
        seq(token.immediate('<'), commaSep1($._template_arg_expression), '>'),
        $.template_args
      ))
    )),

    call_expression: $ => prec.left(18, seq(
      optional($.call_attributes),
      $._expression,
      $.argument_list
    )),

    argument_list: $ => seq(
      '(',
      commaSep($._expression),
      ')'
    ),

    subscript_expression: $ => prec.dynamic(-10, prec.left(18, seq(
      $._expression,
      '[',
      $._expression,
      ']'
    ))),

    // ----------------------------------------------------------------------------
    // Casts
    // ----------------------------------------------------------------------------

    cast_operator: $ => prec.right(18, seq(
      choice('cast', 'static_cast', 'reinterpret_cast', 'checked_cast'),
      optional(seq('<', $._type, '>'))
    )),

    // ----------------------------------------------------------------------------
    // Built-in Functions
    // ----------------------------------------------------------------------------

    builtin_function: $ => choice(
      seq('mux', '(', $._expression, ',', commaSep1($._expression), ')'),
      seq('concat', '(', commaSep1($._expression), ')'),
      seq('fan_out', '<', $._expression, '>', '(', $._expression, ')'),
      seq('lutmul', '(', $._expression, ',', $._expression, ')'),
    ),

    // ----------------------------------------------------------------------------
    // Templates & Qualified Names
    // ----------------------------------------------------------------------------

    template_instantiation: $ => prec.dynamic(-1, seq(
      optional($.scope_qualifier),
      optional('template'),
      $.identifier,
      token.immediate('<'),
      commaSep1($._template_arg_expression),
      '>'
    )),

    // Qualified identifier handles paths like a::b::c or Foo<T>::Bar::method
    qualified_identifier: $ => prec.left(seq(
      optional('template'),
      $.identifier,
      optional(seq(token.immediate('<'), commaSep1($._template_arg_expression), '>')),
      repeat1(seq(
        token.immediate('::'),
        optional('template'),
        $.identifier,
        optional(seq(token.immediate('<'), commaSep1($._template_arg_expression), '>'))
      ))
    )),

    // ----------------------------------------------------------------------------
    // Lambda Expressions
    // ----------------------------------------------------------------------------

    lambda_expression: $ => seq(
      '[',
      commaSep($.capture),
      ']',
      optional(seq('(', commaSep($.parameter), ')')),
      optional(seq('->', $._type)),
      $.block
    ),

    capture: $ => choice(
      $.identifier,
      seq('&', $.identifier),
      seq('this'),
      seq($.identifier, '=', $._expression),
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
      commaSep(choice($._expression, $.initializer)),
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
      choice($._expression, $.initializer)
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
        /0[bB]_?[01](_?[01])*/,                    // Binary
        /0[oO]_?[0-7](_?[0-7])*/,                  // Octal
        /0[xX]_?[0-9a-fA-F](_?[0-9a-fA-F])*/,      // Hexadecimal
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
      $._expression,
      optional(token.immediate('=')),
      optional(seq(
        token.immediate(','),
        $._expression
      )),
      optional(token.immediate(seq(
        ':',
        /[bodxX]/,
        optional(/[0-9]+/)
      ))),
      token.immediate('}')
    ),

    // ============================================================================
    // Identifiers
    // ============================================================================

    _word: $ => /[a-zA-Z_][a-zA-Z0-9_]*/,
    
    identifier: $ => $._word,
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
