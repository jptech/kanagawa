use anyhow::{anyhow, Context, Result};
use kanagawa_parsetree::{sys, BackendOptions};
use kanagawa_syntax as syntax;
use libloading::Library;
use std::{
    env,
    path::{Path, PathBuf},
};

type InitCompilerFn = unsafe extern "C" fn(*const sys::Options) -> sys::BOOL;
type CodegenFn = unsafe extern "C" fn(
    *const i8,
    *const i8,
    *const i8,
    *const i8,
    *const i8,
    sys::ParseTreeNodePtr,
) -> sys::BOOL;
type ParseBaseListFn = unsafe extern "C" fn(sys::ParseTreeNodePtr) -> sys::ParseTreeNodePtr;

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();

    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("kanagawa-rs (rust frontend scaffold) v0.1.0");
        return Ok(());
    }

    let mut backend_lib: Option<PathBuf> = env::var_os("KANAGAWA_BACKEND_LIB").map(PathBuf::from);
    let mut target_device = String::from("mock");
    let mut files: Vec<PathBuf> = Vec::new();
    let mut smoke_codegen = false;
    let mut lex_only = false;
    let mut parse_only = false;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--backend-lib" => {
                i += 1;
                let v = args
                    .get(i)
                    .ok_or_else(|| anyhow!("--backend-lib requires a value"))?;
                backend_lib = Some(PathBuf::from(v));
            }
            "--target-device" | "--device" => {
                i += 1;
                let v = args
                    .get(i)
                    .ok_or_else(|| anyhow!("--target-device requires a value"))?;
                target_device = v.clone();
            }
            "--smoke-codegen" => {
                smoke_codegen = true;
            }
            "--lex" => {
                lex_only = true;
            }
            "--parse" => {
                parse_only = true;
            }
            s if s.starts_with('-') => {
                // For now ignore unknown flags; the full CLI will come later.
            }
            s => files.push(Path::new(s).to_path_buf()),
        }

        i += 1;
    }

    if files.is_empty() {
        return Err(anyhow!(
            "No input files specified (provide at least one .k/.pd file)"
        ));
    }

    if lex_only || parse_only {
        let path = &files[0];
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading {}", path.display()))?;

        if lex_only {
            let (tokens, diags) = syntax::lex(&text);
            println!("lex: {} tokens, {} diagnostics", tokens.len(), diags.len());
            for d in diags.iter().take(10) {
                println!("{:?}: {} ({}..{})", d.severity, d.message, d.span.start, d.span.end);
            }
            return Ok(());
        }

        if parse_only {
            let parse = syntax::parse_file(&text);
            println!("parse: green tree built, {} diagnostics", parse.diagnostics.len());
            for d in parse.diagnostics.iter().take(10) {
                println!("{:?}: {} ({}..{})", d.severity, d.message, d.span.start, d.span.end);
            }
            return Ok(());
        }
    }

    let backend_lib = backend_lib.ok_or_else(|| {
        anyhow!(
            "Backend library not specified. Set KANAGAWA_BACKEND_LIB=/path/to/libkanagawa.(dylib|so) or pass --backend-lib <path>."
        )
    })?;

    let cmd_args_joined = args.join(" ");
    let options = BackendOptions::new(&cmd_args_joined, &target_device, &files)
        .context("building backend Options")?;

    // Load backend dynamically so we don't require a specific build layout.
    let lib = unsafe { Library::new(&backend_lib) }
        .with_context(|| format!("loading backend library at {}", backend_lib.display()))?;

    let init_compiler: libloading::Symbol<InitCompilerFn> =
        unsafe { lib.get(b"InitCompiler") }.context("resolving InitCompiler symbol")?;

    let ok = unsafe { init_compiler(options.as_ptr()) };
    if ok == 0 {
        return Err(anyhow!("InitCompiler failed"));
    }

    println!("InitCompiler ok");

    if smoke_codegen {
        let parse_base_list: libloading::Symbol<ParseBaseListFn> =
            unsafe { lib.get(b"ParseBaseList") }.context("resolving ParseBaseList symbol")?;

        let codegen: libloading::Symbol<CodegenFn> =
            unsafe { lib.get(b"Codegen") }.context("resolving Codegen symbol")?;

        // Empty root: enough to exercise the pipeline entry, but expected to fail later
        // (e.g. device config validation) until we emit a real program ParseTree.
        let root = unsafe { parse_base_list(std::ptr::null_mut()) };

        let backend = std::ffi::CString::new("sv")?;
        let output = std::ffi::CString::new("/tmp/kanagawa-rs-smoke")?;
        let empty = std::ffi::CString::new("")?;

        let ok = unsafe {
            codegen(
                backend.as_ptr(),
                output.as_ptr(),
                empty.as_ptr(),
                empty.as_ptr(),
                empty.as_ptr(),
                root,
            )
        };

        if ok == 0 {
            return Err(anyhow!(
                "Codegen failed (expected until ParseTree emission is implemented)"
            ));
        }

        println!("Codegen ok");
    }

    Ok(())
}
