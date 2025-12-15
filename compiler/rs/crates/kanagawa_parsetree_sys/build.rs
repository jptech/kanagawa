use std::{env, path::PathBuf};

fn main() {
    // Regenerate if the headers change.
    println!("cargo:rerun-if-changed=../../../../compiler/cpp/parse_tree.h");
    println!("cargo:rerun-if-changed=../../../../compiler/cpp/options.h");

    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));

    // We bindgen `parse_tree.h` which includes `options.h`.
    let header = crate_dir.join("../../../../compiler/cpp/parse_tree.h");

    // Include paths needed by parse_tree.h.
    // `parse_tree.h` includes "options.h" which lives alongside it.
    let include_dir = crate_dir.join("../../../../compiler/cpp");

    let mut builder = bindgen::Builder::default()
        .header(header.to_string_lossy())
        .clang_arg(format!("-I{}", include_dir.to_string_lossy()))
        // The backend headers are compiled as part of the C++ build and may
        // rely on transitive includes for basic typedefs like `size_t`.
        // For bindgen, force-include standard headers to make parsing robust.
        .clang_args(["-include", "stddef.h"])
        .allowlist_type("Location")
        .allowlist_type("Options")
        .allowlist_type("CodeGenOptions")
        .allowlist_type("PlacementOptions")
        .allowlist_type("VerbosityLevel")
        .allowlist_type("ParseTree.*")
        .allowlist_type("ParseTreeNodePtr")
        .allowlist_var("DECLARE_FLAG_.*")
        .allowlist_function("InitCompiler")
        .allowlist_function("Codegen")
        .allowlist_function("SetLocation2")
        .allowlist_function("UnknownLocation")
        .allowlist_function("SetNodeType")
        .allowlist_function("Parse.*")
        .derive_default(true)
        .derive_eq(true)
        .derive_hash(true)
        .generate_comments(true)
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()));

    // `options.h` uses `BOOL` typedef, and includes C std headers.
    // Bindgen generally handles this, but keep it explicit.
    builder = builder.clang_arg("-std=c11");

    let bindings = builder
        .generate()
        .expect("Unable to generate bindings for parse_tree.h");

    let bindings_path = out_dir.join("bindings.rs");
    bindings
        .write_to_file(&bindings_path)
        .expect("Couldn't write bindings!");

    // Expose the generated file path to the crate.
    println!(
        "cargo:rustc-env=KANAGAWA_PARSETREE_SYS_BINDINGS={}",
        bindings_path.display()
    );
}
