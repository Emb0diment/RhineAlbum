import { h as UINT64_LE, F as FourCcToken, o as INT32_LE, p as INT64_LE, q as ID3v2Header, m as makeUnexpectedFileContentError, d as initDebug } from "./core-Do6jzaB1.js";
import { A as AbstractID3Parser } from "./AbstractID3Parser-DnZ3IA8O.js";
import { I as ID3v2Parser } from "./ID3v2Parser-DyHU8NYs.js";
const ChunkHeader = {
  len: 12,
  get: (buf, off) => {
    return { id: FourCcToken.get(buf, off), size: UINT64_LE.get(buf, off + 4) };
  }
};
const DsdChunk = {
  len: 16,
  get: (buf, off) => {
    return {
      fileSize: UINT64_LE.get(buf, off),
      metadataPointer: UINT64_LE.get(buf, off + 8)
    };
  }
};
const FormatChunk = {
  len: 40,
  get: (buf, off) => {
    return {
      formatVersion: INT32_LE.get(buf, off),
      formatID: INT32_LE.get(buf, off + 4),
      channelType: INT32_LE.get(buf, off + 8),
      channelNum: INT32_LE.get(buf, off + 12),
      samplingFrequency: INT32_LE.get(buf, off + 16),
      bitsPerSample: INT32_LE.get(buf, off + 20),
      sampleCount: INT64_LE.get(buf, off + 24),
      blockSizePerChannel: INT32_LE.get(buf, off + 32)
    };
  }
};
const debug = initDebug("music-metadata:parser:DSF");
class DsdContentParseError extends makeUnexpectedFileContentError("DSD") {
}
class DsfParser extends AbstractID3Parser {
  async postId3v2Parse() {
    const p0 = this.tokenizer.position;
    const chunkHeader = await this.tokenizer.readToken(ChunkHeader);
    if (chunkHeader.id !== "DSD ") {
      throw new DsdContentParseError("Invalid chunk signature");
    }
    if (chunkHeader.size !== BigInt(ChunkHeader.len + DsdChunk.len)) {
      throw new DsdContentParseError(`Invalid DSD chunk size: ${chunkHeader.size}`);
    }
    this.metadata.setFormat("container", "DSF");
    this.metadata.setFormat("lossless", true);
    this.metadata.setAudioOnly();
    const dsdChunk = await this.tokenizer.readToken(DsdChunk);
    if (dsdChunk.fileSize < chunkHeader.size) {
      throw new DsdContentParseError(`Invalid DSF file size: ${dsdChunk.fileSize}`);
    }
    await this.parseChunks(dsdChunk.fileSize - chunkHeader.size);
    if (dsdChunk.metadataPointer === 0n) {
      debug("No ID3v2 tag present");
      return;
    }
    debug(`expect ID3v2 at offset=${dsdChunk.metadataPointer}`);
    const metadataOffset = dsdChunk.metadataPointer - BigInt(this.tokenizer.position - p0);
    if (metadataOffset < 0n || metadataOffset > BigInt(Number.MAX_SAFE_INTEGER) || dsdChunk.metadataPointer + BigInt(ID3v2Header.len) > dsdChunk.fileSize) {
      throw new DsdContentParseError(`Invalid metadata pointer: ${dsdChunk.metadataPointer}`);
    }
    await this.tokenizer.ignore(Number(metadataOffset));
    return new ID3v2Parser().parse(this.metadata, this.tokenizer, this.options);
  }
  async parseChunks(bytesRemaining) {
    const chunkHeaderSize = BigInt(ChunkHeader.len);
    while (bytesRemaining >= chunkHeaderSize) {
      const chunkHeader = await this.tokenizer.readToken(ChunkHeader);
      debug(`Parsing chunk name=${chunkHeader.id} size=${chunkHeader.size}`);
      if (chunkHeader.size < chunkHeaderSize) {
        throw new DsdContentParseError(`Invalid ${chunkHeader.id} chunk size: ${chunkHeader.size}`);
      }
      if (chunkHeader.size > bytesRemaining) {
        throw new DsdContentParseError(`${chunkHeader.id} chunk exceeds remaining file size`);
      }
      const payloadSize = chunkHeader.size - chunkHeaderSize;
      switch (chunkHeader.id) {
        case "fmt ": {
          if (payloadSize < BigInt(FormatChunk.len)) {
            throw new DsdContentParseError(`Invalid fmt chunk size: ${chunkHeader.size}`);
          }
          const formatChunk = await this.tokenizer.readToken(FormatChunk);
          this.metadata.setFormat("numberOfChannels", formatChunk.channelNum);
          this.metadata.setFormat("sampleRate", formatChunk.samplingFrequency);
          this.metadata.setFormat("bitsPerSample", formatChunk.bitsPerSample);
          this.metadata.setFormat("numberOfSamples", formatChunk.sampleCount);
          this.metadata.setFormat("duration", Number(formatChunk.sampleCount) / formatChunk.samplingFrequency);
          const bitrate = formatChunk.bitsPerSample * formatChunk.samplingFrequency * formatChunk.channelNum;
          this.metadata.setFormat("bitrate", bitrate);
          return;
        }
        default:
          await this.tokenizer.ignore(Number(payloadSize));
          break;
      }
      bytesRemaining -= chunkHeader.size;
    }
  }
}
export {
  DsdContentParseError,
  DsfParser
};
