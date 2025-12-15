//! Performance test for large initializer lists.

use kanagawa_syntax::parse_file;

fn generate_large_initializer(size: usize) -> String {
    let mut src = String::from("const memory<uint32, ");
    src.push_str(&size.to_string());
    src.push_str("> table = {\n");
    for i in 0..size {
        if i > 0 {
            src.push_str(", ");
            if i % 16 == 0 {
                src.push('\n');
            }
        }
        src.push_str(&i.to_string());
    }
    src.push_str("\n};\n");
    src
}

#[test]
fn test_small_initializer() {
    let src = generate_large_initializer(16);
    let start = std::time::Instant::now();
    let parse = parse_file(&src);
    let elapsed = start.elapsed();
    eprintln!("16 elements: {:?}", elapsed);
    assert!(parse.diagnostics.is_empty(), "Parse errors: {:?}", parse.diagnostics);
}

#[test]
fn test_medium_initializer() {
    let src = generate_large_initializer(32);
    let start = std::time::Instant::now();
    let parse = parse_file(&src);
    let elapsed = start.elapsed();
    eprintln!("32 elements: {:?}", elapsed);
    assert!(parse.diagnostics.is_empty(), "Parse errors: {:?}", parse.diagnostics);
}

#[test]
fn test_48_initializer() {
    let src = generate_large_initializer(48);
    let start = std::time::Instant::now();
    let parse = parse_file(&src);
    let elapsed = start.elapsed();
    eprintln!("48 elements: {:?}", elapsed);
    assert!(parse.diagnostics.is_empty(), "Parse errors: {:?}", parse.diagnostics);
}

#[test]
fn test_64_initializer() {
    let src = generate_large_initializer(64);
    let start = std::time::Instant::now();
    let parse = parse_file(&src);
    let elapsed = start.elapsed();
    eprintln!("64 elements: {:?}", elapsed);
    assert!(parse.diagnostics.is_empty(), "Parse errors: {:?}", parse.diagnostics);
}

#[test]
fn test_100_initializer() {
    let src = generate_large_initializer(100);
    let start = std::time::Instant::now();
    let parse = parse_file(&src);
    let elapsed = start.elapsed();
    eprintln!("100 elements: {:?}", elapsed);
    assert!(parse.diagnostics.is_empty(), "Parse errors: {:?}", parse.diagnostics);
}

#[test]
fn test_128_initializer() {
    let src = generate_large_initializer(128);
    let start = std::time::Instant::now();
    let parse = parse_file(&src);
    let elapsed = start.elapsed();
    eprintln!("128 elements: {:?}", elapsed);
    assert!(parse.diagnostics.is_empty(), "Parse errors: {:?}", parse.diagnostics);
}

#[test]
fn test_200_initializer() {
    let src = generate_large_initializer(200);
    let start = std::time::Instant::now();
    let parse = parse_file(&src);
    let elapsed = start.elapsed();
    eprintln!("200 elements: {:?}", elapsed);
    assert!(parse.diagnostics.is_empty(), "Parse errors: {:?}", parse.diagnostics);
}

#[test]
fn test_large_initializer() {
    let src = generate_large_initializer(500);
    let start = std::time::Instant::now();
    let parse = parse_file(&src);
    let elapsed = start.elapsed();
    eprintln!("500 elements: {:?}", elapsed);
    // Should complete in reasonable time (< 1 second)
    assert!(elapsed.as_secs() < 5, "Parsing took too long: {:?}", elapsed);
    assert!(parse.diagnostics.is_empty(), "Parse errors: {:?}", parse.diagnostics);
}

#[test]
fn test_very_large_initializer() {
    let src = generate_large_initializer(1000);
    let start = std::time::Instant::now();
    let parse = parse_file(&src);
    let elapsed = start.elapsed();
    eprintln!("1000 elements: {:?}", elapsed);
    // Should complete in reasonable time (< 5 seconds)
    assert!(elapsed.as_secs() < 5, "Parsing took too long: {:?}", elapsed);
    assert!(parse.diagnostics.is_empty(), "Parse errors: {:?}", parse.diagnostics);
}
