use serde::{de::DeserializeOwned, Serialize};
use std::io;

pub const MAX_FRAME: u32 = 16 * 1024 * 1024;

pub fn encode_frame<T: Serialize>(
    opcode: u8,
    body: &T,
) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    let payload = rmp_serde::to_vec_named(body)?;
    let length = (payload.len() + 1) as u32;
    let mut frame = Vec::with_capacity(payload.len() + 5);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.push(opcode);
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_body<T: DeserializeOwned>(frame: &[u8]) -> Result<(u8, T), rmp_serde::decode::Error> {
    let opcode = frame[0];
    Ok((opcode, rmp_serde::from_slice(&frame[1..])?))
}

pub async fn read_frame<R: tokio::io::AsyncRead + Unpin>(reader: &mut R) -> io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let length = reader.read_u32().await?;
    if length == 0 || length > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid frame length",
        ));
    }
    let mut frame = vec![0; length as usize];
    reader.read_exact(&mut frame).await?;
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::{decode_body, encode_frame};
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Deserialize, PartialEq, Serialize)]
    struct Message {
        value: String,
    }

    #[test]
    fn encodes_opcode_and_messagepack_body() {
        let frame = encode_frame(
            7,
            &Message {
                value: "hello".into(),
            },
        )
        .unwrap();
        assert_eq!(
            u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize,
            frame.len() - 4
        );
        assert_eq!(frame[4], 7);
        assert_eq!(
            decode_body::<Message>(&frame[4..]).unwrap(),
            (
                7,
                Message {
                    value: "hello".into()
                }
            )
        );
    }
}
