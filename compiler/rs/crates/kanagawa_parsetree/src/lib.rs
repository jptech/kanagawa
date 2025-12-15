use std::{
    ffi::{CStr, CString},
    os::raw::c_char,
    path::Path,
};

pub use kanagawa_parsetree_sys as sys;

/// Construct backend option structs in a way that matches the current
/// Haskell frontend defaults closely enough for `InitCompiler` to succeed.
///
/// The backend validates a few invariants in `SetupCodeGenConfig` (see
/// `compiler/cpp/config.cpp`). If these are not satisfied, `InitCompiler`
/// fails before any ParseTree is processed.
pub fn default_codegen_options() -> sys::CodeGenOptions {
    // Defaults mirror `compiler/hs/app/Options/CmdArgs.hs` (compile mode)
    // for the fields that `SetupCodeGenConfig` validates.
    sys::CodeGenOptions {
        // Diagnostics / optimization
        _optimize: 2,
        _verbosity: 1, // Normal

        // Scheduling / legality checks
        _logicRegisterRatio: 2,
        _resetCycles: 3,
        _resetFanOutCycles: 1,
        _stall: 0,

        // Must be >=2 and pow2
        _maxSelectInputs: 16,

        // Must be pow2
        _maxThreadsDefault: 512,
        _maxThreadsLimit: 512,

        // Must be disabled (backend currently rejects enabling these)
        _clockGatingLevel: 0,
        _stallablePipelines: 0,

        // Keep other fields at backend defaults (0/false) for now.
        ..Default::default()
    }
}

pub fn default_placement_options() -> sys::PlacementOptions {
    sys::PlacementOptions {
        _numIterations: 3000,
        _seed: 1,
        _pullStrength: 100.0,
        _pushStrength: 0.001,
        _wallStrength: 0.001,
        _updateRate: 0.005,
        _display: 0,
    }
}

/// Owns all memory that is referenced by the backend `Options` struct.
///
/// Safety: pointers stored in `sys::Options` are valid for the lifetime
/// of this object.
pub struct BackendOptions {
    _cmd_args: CString,
    _device_name: CString,
    _file_names: CStringArray,
    options: sys::Options,
}

impl BackendOptions {
    pub fn new(
        cmd_args: &str,
        device_name: &str,
        file_names: &[impl AsRef<Path>],
    ) -> anyhow::Result<Self> {
        let cmd_args = CString::new(cmd_args)?;
        let device_name = CString::new(device_name)?;

        let file_names_vec: Vec<String> = file_names
            .iter()
            .map(|p| p.as_ref().to_string_lossy().to_string())
            .collect();

        let mut file_names_arr = CStringArray::from_strings(file_names_vec);

        // The backend requires at least one input file.
        if file_names_arr.ptrs.len() <= 1 {
            anyhow::bail!("No input files specified");
        }

        let mut options = sys::Options {
            _frequency: 0,
            _codegenOptions: default_codegen_options(),
            _placementOptions: default_placement_options(),
            ..Default::default()
        };

        options._cmdArgs = cmd_args.as_ptr();
        options._deviceName = device_name.as_ptr();
        options._fileNames = file_names_arr.as_mut_ptr();

        Ok(Self {
            _cmd_args: cmd_args,
            _device_name: device_name,
            _file_names: file_names_arr,
            options,
        })
    }

    pub fn as_ptr(&self) -> *const sys::Options {
        &self.options as *const sys::Options
    }
}

/// Minimal CString arena so pointers passed to the backend remain valid
/// for at least the duration of the compilation.
#[derive(Default)]
pub struct CStringArena {
    storage: Vec<CString>,
}

impl CStringArena {
    pub fn push(&mut self, s: &str) -> *const c_char {
        let c = CString::new(s).expect("CString::new");
        let ptr = c.as_ptr();
        self.storage.push(c);
        ptr
    }

    pub fn push_cstring(&mut self, c: CString) -> *const c_char {
        let ptr = c.as_ptr();
        self.storage.push(c);
        ptr
    }
}

/// Helper for building a null-terminated `char*[]` array.
#[derive(Default)]
#[allow(dead_code)]
pub struct CStringArray {
    cstrings: Vec<CString>,
    ptrs: Vec<*const c_char>,
}

impl CStringArray {
    pub fn from_strings<I, S>(strings: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut cstrings = Vec::new();
        let mut ptrs = Vec::new();

        for s in strings {
            let c = CString::new(s.as_ref()).expect("CString::new");
            ptrs.push(c.as_ptr());
            cstrings.push(c);
        }

        ptrs.push(std::ptr::null());

        Self { cstrings, ptrs }
    }

    pub fn as_ptr(&self) -> *const *const c_char {
        self.ptrs.as_ptr()
    }

    pub fn as_mut_ptr(&mut self) -> *mut *const c_char {
        self.ptrs.as_mut_ptr()
    }
}

/// Safe wrapper around `SetLocation2`.
pub fn set_location(loc: &sys::Location) {
    unsafe {
        sys::SetLocation2(loc as *const sys::Location);
    }
}

pub fn unknown_location() {
    unsafe {
        sys::UnknownLocation();
    }
}

/// Convenience to create a `Location` from 1-based (line, col) pairs.
pub fn make_location(
    begin_line: usize,
    begin_col: usize,
    end_line: usize,
    end_col: usize,
    file_index: usize,
) -> sys::Location {
    sys::Location {
        _beginLine: begin_line,
        _beginColumn: begin_col,
        _endLine: end_line,
        _endColumn: end_col,
        _fileIndex: file_index,
        _valid: true,
    }
}

/// Minimal utility mirroring the Haskell list-building pattern:
/// `ParseBaseList(null)`, then `ParseAppendList`.
pub fn build_list(nodes: &[sys::ParseTreeNodePtr]) -> sys::ParseTreeNodePtr {
    unsafe {
        let mut list = sys::ParseBaseList(std::ptr::null_mut());
        for &n in nodes {
            list = sys::ParseAppendList(list, n);
        }
        list
    }
}

/// Helper for `ParseIdentifier`.
pub fn parse_identifier(name: &CStr) -> sys::ParseTreeNodePtr {
    unsafe { sys::ParseIdentifier(name.as_ptr()) }
}
