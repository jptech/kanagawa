use anyhow::{anyhow, Context, Result};
use kanagawa_codegen::CodeGen;
use kanagawa_parsetree::{sys, BackendOptions, build_list};
use kanagawa_syntax as syntax;
use std::{
    collections::{HashMap, HashSet},
    env,
    fs,
    path::{Path, PathBuf},
};

/// Compiler context for multi-file compilation.
struct CompileContext {
    /// Import directories to search for modules.
    import_dirs: Vec<PathBuf>,
    /// Target device name (affects import resolution).
    target_device: String,
    /// Parsed files cache: canonical path -> parse tree nodes.
    parsed_files: HashMap<PathBuf, Vec<sys::ParseTreeNodePtr>>,
    /// Files currently being parsed (for cycle detection).
    in_progress: HashSet<PathBuf>,
    /// Shared code generator (preserves module re-exports across files).
    codegen: CodeGen,
}

impl CompileContext {
    fn new(import_dirs: Vec<PathBuf>, target_device: String) -> Self {
        Self {
            import_dirs,
            target_device,
            parsed_files: HashMap::new(),
            in_progress: HashSet::new(),
            codegen: CodeGen::new(),
        }
    }

    /// Resolve a module path to a file path.
    /// Module path like "control.async" -> "control/async.k"
    /// Relative imports like ".options" are resolved relative to the importing file.
    /// Returns None for synthetic modules like ".cmdargs" which are handled specially.
    fn resolve_module(&self, module_path: &str, from_dir: &Path) -> Option<PathBuf> {
        // Handle synthetic modules - these are generated, not loaded from files
        if module_path == ".cmdargs" {
            // Synthetic module - handled specially in do_parse_file
            return None;
        }

        // Handle relative imports (starting with .)
        // ".options" from "control/loop.k" -> "control/options.k"
        if module_path.starts_with('.') {
            let relative_path = module_path.trim_start_matches('.').replace('.', "/") + ".k";
            let full_path = from_dir.join(&relative_path);
            if full_path.exists() {
                return Some(full_path);
            }
            // Relative import not found - this might be optional
            return None;
        }

        // Convert module path to file path
        let file_path = module_path.replace('.', "/") + ".k";

        // Build search directories: device-specific paths first, then regular paths
        let mut search_dirs = Vec::new();

        // Add device-specific paths first
        for dir in &self.import_dirs {
            search_dirs.push(dir.join("device").join(&self.target_device));
        }

        // Then add regular import directories
        search_dirs.extend(self.import_dirs.iter().cloned());

        // Also search from the directory of the importing file
        search_dirs.push(from_dir.to_path_buf());

        // Search for the file
        for dir in &search_dirs {
            let full_path = dir.join(&file_path);
            if full_path.exists() {
                return Some(full_path);
            }
        }

        None
    }

    /// Load device configuration files from the device directory.
    /// The device directory is library/device/<device-name>/
    fn load_device_config(&mut self) -> Result<()> {
        for import_dir in &self.import_dirs.clone() {
            let device_dir = import_dir.join("device").join(&self.target_device);
            if !device_dir.exists() {
                continue;
            }

            // Load hardware/config.k first (main device configuration)
            let config_path = device_dir.join("hardware").join("config.k");
            if config_path.exists() {
                if std::env::var("KANAGAWA_DEBUG").is_ok() {
                    eprintln!("Loading device config: {}", config_path.display());
                }
                self.parse_file_recursive(&config_path)?;
            }

            // Skip numeric/float32/operator.k and hardware/dsp.k for now
            // These use templates that we can't fully resolve yet.
            // TODO: Re-enable when template resolution is implemented
            //
            // Load numeric/float32/operator.k (floating point operations)
            // let float_op_path = device_dir.join("numeric").join("float32").join("operator.k");
            // if float_op_path.exists() {
            //     if std::env::var("KANAGAWA_DEBUG").is_ok() {
            //         eprintln!("Loading float ops: {}", float_op_path.display());
            //     }
            //     self.parse_file_recursive(&float_op_path)?;
            // }

            // Load hardware/dsp.k (DSP configuration)
            // let dsp_path = device_dir.join("hardware").join("dsp.k");
            // if dsp_path.exists() {
            //     if std::env::var("KANAGAWA_DEBUG").is_ok() {
            //         eprintln!("Loading DSP config: {}", dsp_path.display());
            //     }
            //     self.parse_file_recursive(&dsp_path)?;
            // }

            // Found and loaded device config
            return Ok(());
        }

        Err(anyhow!("Device configuration not found for target: {}", self.target_device))
    }

    /// Parse a file and all its imports recursively.
    fn parse_file_recursive(&mut self, path: &Path) -> Result<Vec<sys::ParseTreeNodePtr>> {
        let canonical = path.canonicalize()
            .with_context(|| format!("canonicalizing {}", path.display()))?;

        // Check if already parsed
        if let Some(nodes) = self.parsed_files.get(&canonical) {
            return Ok(nodes.clone());
        }

        // Check for cycles
        if self.in_progress.contains(&canonical) {
            return Err(anyhow!("Circular import detected: {}", path.display()));
        }

        self.in_progress.insert(canonical.clone());

        let result = self.do_parse_file(&canonical);

        self.in_progress.remove(&canonical);

        if let Ok(ref nodes) = result {
            self.parsed_files.insert(canonical, nodes.clone());
        }

        result
    }

    fn do_parse_file(&mut self, path: &Path) -> Result<Vec<sys::ParseTreeNodePtr>> {
        let text = fs::read_to_string(path)
            .with_context(|| format!("reading {}", path.display()))?;

        let file_dir = path.parent().unwrap_or(Path::new("."));

        // Step 1: Parse source to CST
        let parse = syntax::parse_file(&text);
        if !parse.diagnostics.is_empty() {
            for d in parse.diagnostics.iter().take(5) {
                eprintln!(
                    "  {:?}: {} ({}..{}) in {}",
                    d.severity, d.message, d.span.start, d.span.end, path.display()
                );
            }
        }

        // Step 2: Lower CST to AST
        let syntax_node = parse.syntax_node();
        let ast = kanagawa_ast::lower_file(&syntax_node)
            .map_err(|e| anyhow!("AST lowering failed for {}: {:?}", path.display(), e))?;

        // Step 3: Parse imports first (to populate the cache)
        // NOTE: We don't collect import nodes here - they'll be collected from the cache
        // at the end to avoid duplicates when the same module is imported multiple times.
        for import in &ast.imports {
            let module_path = import.name.segments.iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join(".");

            // Skip synthetic modules - they are generated, not loaded from files
            if module_path == ".cmdargs" {
                // The .cmdargs module is a synthetic module for command-line defines.
                // We'll generate an empty stub for now.
                continue;
            }

            // Handle .options as a synthetic module that re-exports compiler.options
            // The Haskell frontend generates this module dynamically with compiler options.
            // For now, we resolve it to compiler.options directly.
            if module_path == ".options" {
                // Load compiler.options instead
                if let Some(options_path) = self.resolve_module("compiler.options", file_dir) {
                    let _ = self.parse_file_recursive(&options_path)?;
                }
                continue;
            }

            if let Some(import_path) = self.resolve_module(&module_path, file_dir) {
                // Parse the import (this populates the cache), but don't collect nodes here
                let _ = self.parse_file_recursive(&import_path)?;
            } else {
                eprintln!("  Warning: Could not resolve import '{}' in {}", module_path, path.display());
            }
        }

        // Step 4: Lower AST to HIR
        let (hir, symbols) = kanagawa_hir::lower_file(&ast)
            .map_err(|e| anyhow!("HIR lowering failed for {}: {:?}", path.display(), e))?;

        // Debug: print HIR items to trace types
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("HIR for {}: {} items", path.display(), hir.items.len());
            for (i, item) in hir.items.iter().enumerate() {
                eprintln!("  Item {}: {:?}", i, std::mem::discriminant(item));
            }
        }

        // Step 4.5: Type check functions
        for item in &hir.items {
            if let kanagawa_hir::HirItem::Function(func) = item {
                let mut checker = kanagawa_hir::TypeChecker::new(&symbols);
                let result = checker.check_function(func);
                if result.has_errors() && std::env::var("KANAGAWA_DEBUG").is_ok() {
                    for err in &result.errors {
                        eprintln!("  Type error in {}: {}", func.name, err);
                    }
                }
            }
        }

        // Step 5: Generate ParseTree from HIR
        // Only return this file's ParseTree, not imports
        // Use the shared codegen to preserve module re-exports across files
        let parsetree = kanagawa_codegen::generate_with_codegen(&mut self.codegen, &hir)
            .map_err(|e| anyhow!("Code generation failed for {}: {:?}", path.display(), e))?;

        let mut nodes = Vec::new();
        if !parsetree.is_null() {
            nodes.push(parsetree);
        }

        Ok(nodes)
    }

    /// Get all parsed nodes from the cache. This should be called after all files
    /// have been parsed to collect unique nodes for codegen.
    fn collect_all_nodes(&self) -> Vec<sys::ParseTreeNodePtr> {
        // Sort files by path for deterministic ordering
        let mut sorted_files: Vec<_> = self.parsed_files.iter().collect();
        sorted_files.sort_by_key(|(path, _)| path.clone());

        let mut all_nodes = Vec::new();
        for (path, nodes) in sorted_files {
            if std::env::var("KANAGAWA_DEBUG").is_ok() {
                eprintln!("collect_all_nodes: {} -> {} nodes", path.display(), nodes.len());
            }
            all_nodes.extend(nodes.iter().cloned());
        }
        all_nodes
    }
}

/// Compile a single source file through the full pipeline: syntax -> AST -> HIR -> ParseTree
fn compile_file(path: &Path) -> Result<sys::ParseTreeNodePtr> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;

    // Step 1: Parse source to CST
    eprintln!("  [1/4] Parsing CST...");
    let parse = syntax::parse_file(&text);
    if !parse.diagnostics.is_empty() {
        for d in &parse.diagnostics {
            eprintln!(
                "{:?}: {} ({}..{})",
                d.severity, d.message, d.span.start, d.span.end
            );
        }
        // Continue even with parse errors for now
    }
    eprintln!("  [1/4] CST parsed successfully");

    // Step 2: Lower CST to AST
    eprintln!("  [2/4] Lowering to AST...");
    let syntax = parse.syntax_node();
    let ast = kanagawa_ast::lower_file(&syntax)
        .map_err(|e| anyhow!("AST lowering failed: {:?}", e))?;
    eprintln!("  [2/4] AST lowered successfully");

    // Step 3: Lower AST to HIR (returns HirFile and SymbolTable)
    eprintln!("  [3/4] Lowering to HIR...");
    let (hir, symbols) = kanagawa_hir::lower_file(&ast)
        .map_err(|e| anyhow!("HIR lowering failed: {:?}", e))?;
    eprintln!("  [3/4] HIR lowered successfully ({} items)", hir.items.len());

    // Step 3.5: Type check functions
    let mut total_errors = 0;
    for item in &hir.items {
        if let kanagawa_hir::HirItem::Function(func) = item {
            let mut checker = kanagawa_hir::TypeChecker::new(&symbols);
            let result = checker.check_function(func);
            if result.has_errors() {
                total_errors += result.errors.len();
                eprintln!("  Type errors in function '{}':", func.name);
                for err in &result.errors {
                    eprintln!("    {}", err);
                }
            }
        }
    }
    if total_errors > 0 {
        eprintln!("  [3.5/4] Type checking completed with {} errors", total_errors);
    } else {
        eprintln!("  [3.5/4] Type checking passed");
    }

    // Step 4: Generate ParseTree from HIR
    eprintln!("  [4/4] Generating ParseTree...");
    let parsetree = kanagawa_codegen::generate(&hir)
        .map_err(|e| anyhow!("Code generation failed: {:?}", e))?;
    eprintln!("  [4/4] ParseTree generated successfully");

    Ok(parsetree)
}

// Using statically linked functions from sys directly instead of libloading
// to avoid RTTI issues with dynamic_cast across shared library boundaries

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
    let mut compile_mode = false;
    let mut lex_only = false;
    let mut parse_only = false;
    let mut output_dir = PathBuf::from("/tmp/kanagawa-rs-out");
    let mut backend_type = String::from("sv");
    let mut import_dirs: Vec<PathBuf> = Vec::new();
    let mut no_implicit_base = false;

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
            "--compile" => {
                compile_mode = true;
            }
            "--output" | "-o" => {
                i += 1;
                let v = args
                    .get(i)
                    .ok_or_else(|| anyhow!("--output requires a value"))?;
                output_dir = PathBuf::from(v);
            }
            "--backend" => {
                i += 1;
                let v = args
                    .get(i)
                    .ok_or_else(|| anyhow!("--backend requires a value"))?;
                backend_type = v.clone();
            }
            "--lex" => {
                lex_only = true;
            }
            "--parse" => {
                parse_only = true;
            }
            "--import-dir" | "-I" => {
                i += 1;
                let v = args
                    .get(i)
                    .ok_or_else(|| anyhow!("--import-dir/-I requires a value"))?;
                import_dirs.push(PathBuf::from(v));
            }
            "--no-implicit-base" => {
                no_implicit_base = true;
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
        let text =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;

        if lex_only {
            let (tokens, diags) = syntax::lex(&text);
            println!("lex: {} tokens, {} diagnostics", tokens.len(), diags.len());
            for d in diags.iter().take(10) {
                println!(
                    "{:?}: {} ({}..{})",
                    d.severity, d.message, d.span.start, d.span.end
                );
            }
            return Ok(());
        }

        if parse_only {
            let parse = syntax::parse_file(&text);
            println!(
                "parse: green tree built, {} diagnostics",
                parse.diagnostics.len()
            );
            for d in parse.diagnostics.iter().take(10) {
                println!(
                    "{:?}: {} ({}..{})",
                    d.severity, d.message, d.span.start, d.span.end
                );
            }
            return Ok(());
        }
    }

    // Backend library is linked at compile time via build.rs
    // We still require the environment variable to be set for consistency,
    // but we don't dynamically load it anymore.
    let _backend_lib = backend_lib.ok_or_else(|| {
        anyhow!(
            "Backend library not specified. Set KANAGAWA_BACKEND_LIB=/path/to/libkanagawa.(dylib|so) or pass --backend-lib <path>."
        )
    })?;

    let cmd_args_joined = args.join(" ");
    let options = BackendOptions::new(&cmd_args_joined, &target_device, &files)
        .context("building backend Options")?;

    // Use the statically linked InitCompiler from sys
    let ok = unsafe { sys::InitCompiler(options.as_ptr()) };
    if ok == 0 {
        return Err(anyhow!("InitCompiler failed"));
    }

    println!("InitCompiler ok");

    if smoke_codegen {
        // Empty root: enough to exercise the pipeline entry, but expected to fail later
        // (e.g. device config validation) until we emit a real program ParseTree.
        let root = unsafe { sys::ParseBaseList(std::ptr::null_mut()) };

        let backend = std::ffi::CString::new("sv")?;
        let output = std::ffi::CString::new("/tmp/kanagawa-rs-smoke")?;
        let empty = std::ffi::CString::new("")?;

        let ok = unsafe {
            sys::Codegen(
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

    if compile_mode {

        // Create compile context with import directories
        let mut ctx = CompileContext::new(import_dirs.clone(), target_device.clone());

        // Step 1: Parse base.k first (unless --no-implicit-base)
        // The base library defines core types like compiler.device.schema
        if !no_implicit_base && !import_dirs.is_empty() {
            let base_path = import_dirs[0].join("base.k");
            if base_path.exists() {
                println!("Parsing base library: {}", base_path.display());
                match ctx.parse_file_recursive(&base_path) {
                    Ok(_) => {
                        println!("  Base library parsed (nodes cached)");
                    }
                    Err(e) => {
                        eprintln!("Warning: Failed to parse base library: {}", e);
                    }
                }
            } else {
                eprintln!("Warning: base.k not found at {}", base_path.display());
            }
        }

        // Step 1.5: Load device configuration (after base library, since device config
        // imports compiler.device.schema which is defined in the base library)
        if !no_implicit_base && !import_dirs.is_empty() {
            println!("Loading device configuration: {}", target_device);
            match ctx.load_device_config() {
                Ok(_) => {
                    println!("  Device configuration loaded");
                }
                Err(e) => {
                    eprintln!("Warning: Failed to load device configuration: {}", e);
                }
            }
        }

        // Step 2: Parse all user files and their imports
        for file in &files {
            println!("Compiling: {}", file.display());
            match ctx.parse_file_recursive(file) {
                Ok(_) => {
                    println!("  File parsed (nodes cached)");
                }
                Err(e) => {
                    return Err(anyhow!("Compilation failed for {}: {}", file.display(), e));
                }
            }
        }

        // Step 3: Collect all unique nodes from the cache
        let all_nodes = ctx.collect_all_nodes();
        // Filter out null pointers
        let mut non_null_nodes: Vec<_> = all_nodes.iter().filter(|n| !n.is_null()).cloned().collect();
        println!("Total nodes collected: {} non-null of {} (from {} files)", non_null_nodes.len(), all_nodes.len(), ctx.parsed_files.len());

        // Debug: limit nodes if KANAGAWA_DEBUG_LIMIT is set
        if let Ok(limit_str) = std::env::var("KANAGAWA_DEBUG_LIMIT") {
            if let Ok(limit) = limit_str.parse::<usize>() {
                if limit < non_null_nodes.len() {
                    eprintln!("Debug: limiting nodes from {} to {}", non_null_nodes.len(), limit);
                    non_null_nodes.truncate(limit);
                }
            }
        }

        // Build the final root list from all nodes
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("Building root list from {} non-null nodes...", non_null_nodes.len());
            for (i, node) in non_null_nodes.iter().enumerate() {
                eprintln!("  Node {}: {:?}", i, node);
            }
        }
        let root = build_list(&non_null_nodes);
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("Root list built: {:?}", root);
            eprintln!("Calling backend codegen...");
            // Flush stderr before calling backend
            use std::io::Write;
            let _ = std::io::stderr().flush();
        }

        // Run the backend codegen
        let backend_cstr = std::ffi::CString::new(backend_type.as_str())?;
        let output_cstr = std::ffi::CString::new(output_dir.to_string_lossy().as_ref())?;
        let empty = std::ffi::CString::new("")?;

        let ok = unsafe {
            sys::Codegen(
                backend_cstr.as_ptr(),
                output_cstr.as_ptr(),
                empty.as_ptr(),
                empty.as_ptr(),
                empty.as_ptr(),
                root,
            )
        };
        if std::env::var("KANAGAWA_DEBUG").is_ok() {
            eprintln!("Backend codegen returned: {}", ok);
        }

        if ok == 0 {
            return Err(anyhow!("Backend codegen failed"));
        }

        println!("Compilation successful! Output: {}", output_dir.display());
    }

    Ok(())
}
