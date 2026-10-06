use std::io::Cursor;
use std::sync::{Arc, Mutex};

pub(super) fn push_f32_samples(buffer: &Arc<Mutex<Vec<i16>>>, data: &[f32]) {
    if let Ok(mut guard) = buffer.lock() {
        guard.extend(data.iter().map(|sample| {
            sample
                .clamp(-1.0, 1.0)
                .mul_add(i16::MAX as f32, 0.0)
                .round() as i16
        }));
    }
}

pub(super) fn push_i16_samples(buffer: &Arc<Mutex<Vec<i16>>>, data: &[i16]) {
    if let Ok(mut guard) = buffer.lock() {
        guard.extend_from_slice(data);
    }
}

pub(super) fn push_u16_samples(buffer: &Arc<Mutex<Vec<i16>>>, data: &[u16]) {
    if let Ok(mut guard) = buffer.lock() {
        guard.extend(data.iter().map(|sample| (*sample as i32 - 32_768) as i16));
    }
}

pub(super) fn encode_wav_bytes(
    samples: &[i16],
    sample_rate: u32,
    channels: u16,
) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::<u8>::new());
    {
        let mut writer =
            hound::WavWriter::new(&mut cursor, spec).map_err(|error| error.to_string())?;
        for sample in samples {
            writer
                .write_sample(*sample)
                .map_err(|error| error.to_string())?;
        }
        writer.finalize().map_err(|error| error.to_string())?;
    }
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_supported_sample_types_to_i16_buffer() {
        let buffer = Arc::new(Mutex::new(Vec::<i16>::new()));
        push_f32_samples(&buffer, &[-1.0, 0.0, 1.0]);
        push_i16_samples(&buffer, &[123]);
        push_u16_samples(&buffer, &[0, 32_768, 65_535]);

        let values = buffer.lock().unwrap().clone();
        assert_eq!(values, vec![-32767, 0, 32767, 123, -32768, 0, 32767]);
    }

    #[test]
    fn encodes_wav_header_and_samples() {
        let bytes = encode_wav_bytes(&[0, 1000, -1000], 16_000, 1).unwrap();

        assert!(bytes.starts_with(b"RIFF"));
        assert_eq!(&bytes[8..12], b"WAVE");
        assert!(bytes.len() > 44);
    }
}
