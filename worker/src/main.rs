use minicomputer_worker::read_frame;
use std::env;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let listen = env::var("MINICOMPUTER_WORKER_LISTEN").unwrap_or_else(|_| "127.0.0.1:7777".into());
    let listener = TcpListener::bind(listen).await?;
    let (mut stream, _) = listener.accept().await?;
    let frame = read_frame(&mut stream).await?;
    if frame.first() != Some(&0) { return Ok(()); }
    stream.write_all(&[0, 0, 0, 1, 1]).await?;
    Ok(())
}
