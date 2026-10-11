//! `phile-agent`: Phile's core for agents.
//!
//!   phile-agent tools                 print the tool table (JSON)
//!   phile-agent call <tool> [json]    run one tool; args as JSON (or on stdin)
//!   phile-agent mcp                   MCP server on stdio (any MCP client)
//!   phile-agent version

use phile_agent::{call, tools, Ctx, VERSION};
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("tools") => out(&json!({ "version": VERSION, "tools": tools() })),
        Some("call") => cli_call(&args[1..]),
        Some("mcp") => mcp(),
        Some("version" | "--version" | "-V") => out(&json!({ "version": VERSION })),
        _ => {
            eprintln!("usage: phile-agent tools | call <tool> [json] | mcp | version");
            2
        }
    };
    std::process::exit(code);
}

fn out(v: &Value) -> i32 {
    println!("{v}");
    0
}

fn cli_call(rest: &[String]) -> i32 {
    let Some(tool) = rest.first() else {
        eprintln!("usage: phile-agent call <tool> [json]");
        return 2;
    };
    let raw = match rest.get(1) {
        Some(j) if j != "-" => j.clone(),
        _ => {
            let mut s = String::new();
            let _ = std::io::stdin().read_to_string(&mut s);
            s
        }
    };
    let args: Value = if raw.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                println!(
                    "{}",
                    json!({ "ok": false, "error": format!("bad JSON arguments: {e}") })
                );
                return 1;
            }
        }
    };
    let mut ctx = Ctx::default();
    if let Some(cwd) = args.get("cwd").and_then(Value::as_str) {
        ctx.cwd = cwd.into();
    }
    match call(&ctx, tool, &args) {
        Ok(v) => out(&json!({ "ok": true, "result": v })),
        Err(e) => {
            println!("{}", json!({ "ok": false, "error": e }));
            1
        }
    }
}

/// Minimal MCP (JSON-RPC 2.0, newline-delimited) server: initialize, tools/list, tools/call, ping.
fn mcp() -> i32 {
    let ctx = Ctx::default();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(
                    stdout,
                    "{}",
                    json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": e.to_string() } })
                );
                continue;
            }
        };
        let Some(id) = msg.get("id").cloned() else {
            continue;
        }; // notification
        let p = msg.get("params").cloned().unwrap_or(json!({}));
        let reply = match msg.get("method").and_then(Value::as_str).unwrap_or("") {
            "initialize" => Ok(json!({
                "protocolVersion": p.get("protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "phile", "version": VERSION },
                "instructions": "Phile file tools. Prefer these over shell commands for listing, searching, moving, copying, renaming and recycling files. Changes are journaled; phile_undo reverses the last batch."
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools() })),
            "tools/call" => {
                let name = p.get("name").and_then(Value::as_str).unwrap_or("");
                let a = p.get("arguments").cloned().unwrap_or(json!({}));
                Ok(match call(&ctx, name, &a) {
                    Ok(v) => {
                        json!({ "content": [{ "type": "text", "text": v.to_string() }], "structuredContent": v, "isError": false })
                    }
                    Err(e) => {
                        json!({ "content": [{ "type": "text", "text": e }], "isError": true })
                    }
                })
            }
            m => Err(json!({ "code": -32601, "message": format!("method not found: {m}") })),
        };
        let resp = match reply {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
        };
        let _ = writeln!(stdout, "{resp}");
        let _ = stdout.flush();
    }
    0
}
