fn main() {
    // The frontend is static files with no bundler, so nothing regenerates
    // ../ui for us. `generate_context!` embeds that directory into the binary
    // at compile time; without this line, editing index.html or panel.js would
    // not rebuild the crate and you would keep running the previous markup.
    println!("cargo:rerun-if-changed=../ui");

    tauri_build::build();
}
