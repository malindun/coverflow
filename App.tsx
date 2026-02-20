import React, { useState, useRef, useMemo, useCallback } from 'react';
import {
  Music,
  Image as ImageIcon,
  Download,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Layers,
  ArrowLeft,
  Trash2,
  Video,
  Check,
  Sparkles,
} from 'lucide-react';
import ID3WriterImport from 'https://esm.sh/browser-id3-writer@4.4.0';
import { Mp3Encoder } from 'lamejs';

const ID3WriterConstructor = (ID3WriterImport as any).default || ID3WriterImport;

interface MatchedPair {
  id: string;
  audio: File;
  image: File | null;
  status: 'matched' | 'missing-image';
}

const App: React.FC = () => {
  const [mode, setMode] = useState<'single' | 'bulk'>('single');

  // Single Mode State
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  // Bulk Mode State
  const [bulkAudioFiles, setBulkAudioFiles] = useState<File[]>([]);
  const [bulkImageFiles, setBulkImageFiles] = useState<File[]>([]);
  const [manualAssignments, setManualAssignments] = useState<Record<string, File>>({});

  // Shared UI State
  const [isProcessing, setIsProcessing] = useState(false);
  const [processStep, setProcessStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const mediaInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const bulkInputRef = useRef<HTMLInputElement>(null);

  // --- Transcoding Engine ---

  /**
   * Encodes an AudioBuffer into an MP3 Blob using the imported Mp3Encoder.
   * This is the browser-native alternative to server-side FFmpeg extraction.
   */
  const encodeMp3 = async (audioBuffer: AudioBuffer): Promise<Blob> => {
    const channels = Math.min(audioBuffer.numberOfChannels, 2);
    const sampleRate = audioBuffer.sampleRate;
    const kbps = 192;

    const encoder = new Mp3Encoder(channels, sampleRate, kbps);
    const mp3Chunks: Uint8Array[] = [];
    const blockSize = 1152;

    const clampToInt16 = (value: number) => {
      const clamped = Math.max(-1, Math.min(1, value));
      return clamped < 0 ? clamped * 32768 : clamped * 32767;
    };

    const left = audioBuffer.getChannelData(0);
    const right = channels > 1 ? audioBuffer.getChannelData(1) : left;

    for (let i = 0; i < left.length; i += blockSize) {
      const leftChunk = new Int16Array(Math.min(blockSize, left.length - i));
      const rightChunk = new Int16Array(leftChunk.length);

      for (let j = 0; j < leftChunk.length; j++) {
        leftChunk[j] = clampToInt16(left[i + j]);
        rightChunk[j] = clampToInt16(right[i + j]);
      }

      const mp3buf = encoder.encodeBuffer(leftChunk, rightChunk);
      if (mp3buf.length > 0) {
        mp3Chunks.push(new Uint8Array(mp3buf));
      }

      if (i % (blockSize * 20) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    const endBuf = encoder.flush();
    if (endBuf.length > 0) {
      mp3Chunks.push(new Uint8Array(endBuf));
    }

    return new Blob(mp3Chunks, { type: 'audio/mp3' });
  };

  /**
   * Embeds artwork into the MP3 using ID3 v2.3 tags.
   */
  const applyID3Tags = async (mp3Blob: Blob, imageFile: File): Promise<Blob> => {
    const mp3Buffer = await mp3Blob.arrayBuffer();
    const imageBuffer = await imageFile.arrayBuffer();

    const writer = new ID3WriterConstructor(mp3Buffer);
    writer.setFrame('APIC', {
      type: 3,
      data: imageBuffer,
      description: 'Cover',
      mimeType: imageFile.type || 'image/jpeg',
    });

    writer.addTag();
    return writer.getBlob();
  };

  // --- Handlers ---

  const handleMediaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const isMedia =
        file.type.startsWith('audio/') ||
        file.type.startsWith('video/') ||
        /\.(mp3|mp4|mov|wav|m4a|webm|aac)$/i.test(file.name);
      if (isMedia) {
        setMediaFile(file);
        setError(null);
        setSuccess(false);
      } else {
        setError('Please select a supported audio or video file.');
      }
    }
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && (file.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(file.name))) {
      setImageFile(file);
      const reader = new FileReader();
      reader.onload = (event) => setImagePreview(event.target?.result as string);
      reader.readAsDataURL(file);
      setError(null);
      setSuccess(false);
    }
  };

  const addFilesToBulk = useCallback((files: File[]) => {
    const audios = files.filter(
      (f) =>
        f.type.startsWith('audio/') ||
        f.type.startsWith('video/') ||
        /\.(mp3|mp4|mov|wav|m4a|webm|aac)$/i.test(f.name),
    );
    const images = files.filter(
      (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(f.name),
    );

    if (audios.length > 0) setBulkAudioFiles((prev) => [...prev, ...audios]);
    if (images.length > 0) setBulkImageFiles((prev) => [...prev, ...images]);

    setError(null);
    setSuccess(false);
  }, []);

  const matchedPairs = useMemo(() => {
    const pairs: MatchedPair[] = [];
    const normalize = (name: string) =>
      name
        .replace(/\.[^/.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .trim();

    bulkAudioFiles.forEach((audio, index) => {
      let matchedImage = manualAssignments[audio.name] || null;
      if (!matchedImage) {
        const audioClean = normalize(audio.name);
        matchedImage = bulkImageFiles.find((img) => normalize(img.name) === audioClean) || null;
      }
      pairs.push({
        id: `${audio.name}-${index}`,
        audio,
        image: matchedImage,
        status: matchedImage ? 'matched' : 'missing-image',
      });
    });
    return pairs;
  }, [bulkAudioFiles, bulkImageFiles, manualAssignments]);

  const processTagger = async () => {
    setError(null);
    setSuccess(false);
    setIsProcessing(true);

    const processItem = async (media: File, artwork: File) => {
      setProcessStep(`Extracting Audio...`);
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const arrayBuffer = await media.arrayBuffer();

      // decodeAudioData seamlessly extracts audio tracks from video files (like MP4) and decodes compressed audio
      const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      setProcessStep('Transcoding to MP3...');
      const mp3Blob = await encodeMp3(decodedBuffer);

      setProcessStep('Embedding Artwork...');
      const finalBlob = await applyID3Tags(mp3Blob, artwork);

      const url = URL.createObjectURL(finalBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${media.name.split('.')[0]}_CoverFlow.mp3`;
      link.click();
      URL.revokeObjectURL(url);
      audioCtx.close();
    };

    try {
      if (mode === 'single') {
        if (!mediaFile || !imageFile) throw new Error('Select both a media file and artwork.');
        await processItem(mediaFile, imageFile);
        setSuccess(true);
      } else {
        const toProcess = matchedPairs.filter((p) => p.image);
        if (toProcess.length === 0) throw new Error('No matched tracks to process.');
        for (const pair of toProcess) {
          setProcessStep(`Processing ${pair.audio.name}...`);
          await processItem(pair.audio, pair.image!);
        }
        setSuccess(true);
      }
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[CoverFlow Error]', err);
      setError(err.message || 'An unexpected error occurred during transcoding.');
    } finally {
      setIsProcessing(false);
      setProcessStep('');
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#121212] flex flex-col items-center justify-center p-4 sm:p-8">
      {/* Dynamic Spotify-esque Background */}
      <div className="fixed inset-0 pointer-events-none opacity-20 overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] bg-[#1DB954] blur-[160px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] bg-[#1DB954] blur-[160px] rounded-full opacity-30" />
      </div>

      <main className="relative z-10 w-full max-w-2xl animate-in fade-in duration-700">
        <header className="mb-10 text-center">
          <h1 className="text-4xl font-black text-white sm:text-6xl flex items-center justify-center gap-4">
            <span className="bg-[#1DB954] p-3 rounded-full shadow-[0_0_30px_rgba(29,185,84,0.5)] transform hover:scale-110 transition-transform duration-300">
              <Music size={36} className="text-black" />
            </span>
            CoverFlow
          </h1>
          <p className="mt-4 text-zinc-500 font-black uppercase text-[11px] tracking-[0.3em]">
            The Ultimate In-Browser Transcoder
          </p>

          <div className="mt-10 flex justify-center">
            <div className="bg-zinc-900/60 p-2 rounded-full flex gap-2 border border-zinc-800 backdrop-blur-xl shadow-2xl">
              <button
                onClick={() => {
                  setMode('single');
                  setSuccess(false);
                }}
                className={`px-10 py-3 rounded-full text-sm font-black transition-all ${mode === 'single' ? 'bg-[#1DB954] text-black shadow-lg scale-105' : 'text-zinc-500 hover:text-white'}`}
              >
                Single Track
              </button>
              <button
                onClick={() => {
                  setMode('bulk');
                  setSuccess(false);
                }}
                className={`px-10 py-3 rounded-full text-sm font-black transition-all ${mode === 'bulk' ? 'bg-[#1DB954] text-black shadow-lg scale-105' : 'text-zinc-500 hover:text-white'}`}
              >
                Bulk Sync
              </button>
            </div>
          </div>
        </header>

        <div className="bg-zinc-900/95 backdrop-blur-3xl border border-zinc-800/80 rounded-[3.5rem] p-8 sm:p-14 shadow-[0_30px_60px_rgba(0,0,0,0.6)] relative overflow-hidden ring-1 ring-white/5">
          {error && (
            <div className="mb-8 p-6 bg-red-500/10 border border-red-500/30 rounded-3xl flex items-center gap-4 text-red-400 text-sm font-bold animate-in slide-in-from-top-4">
              <AlertCircle size={24} />
              {error}
            </div>
          )}
          {success && (
            <div className="mb-8 p-6 bg-[#1DB954]/10 border border-[#1DB954]/30 rounded-3xl flex items-center gap-4 text-[#1DB954] text-sm font-bold animate-in slide-in-from-top-4">
              <CheckCircle2 size={24} />
              Complete! Check your downloads folder.
            </div>
          )}

          {mode === 'single' ? (
            <div className="animate-in fade-in zoom-in-95 duration-500">
              <div className="mb-12 group relative max-w-[320px] mx-auto">
                <div
                  className={`aspect-square w-full rounded-[3rem] overflow-hidden bg-zinc-800/30 shadow-2xl flex items-center justify-center border-2 border-dashed ${imagePreview ? 'border-transparent' : 'border-zinc-700 hover:border-[#1DB954]'} transition-all cursor-pointer relative group-hover:shadow-[#1DB954]/15`}
                  onClick={() => imageInputRef.current?.click()}
                >
                  {imagePreview ? (
                    <img
                      src={imagePreview}
                      alt="Artwork"
                      className="w-full h-full object-cover transition-transform duration-1000 group-hover:scale-110"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-5 text-zinc-500 group-hover:text-[#1DB954] transition-colors">
                      <ImageIcon size={72} strokeWidth={1} />
                      <p className="font-black uppercase text-[11px] tracking-widest">
                        Upload Cover Art
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-8">
                <input
                  type="file"
                  ref={mediaInputRef}
                  onChange={handleMediaChange}
                  accept="audio/*,video/*"
                  className="hidden"
                />
                <input
                  type="file"
                  ref={imageInputRef}
                  onChange={handleImageChange}
                  accept="image/*"
                  className="hidden"
                />

                <div
                  className={`p-7 rounded-[2.5rem] border-2 cursor-pointer flex items-center gap-6 transition-all ${mediaFile ? 'bg-[#1DB954]/5 border-[#1DB954]/40 shadow-[inset_0_0_20px_rgba(29,185,84,0.05)]' : 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-600'}`}
                  onClick={() => mediaInputRef.current?.click()}
                >
                  <div
                    className={`p-5 rounded-3xl transition-all ${mediaFile ? 'bg-[#1DB954] text-black shadow-xl scale-105' : 'bg-zinc-800 text-zinc-500'}`}
                  >
                    {mediaFile?.type.startsWith('video/') ? (
                      <Video size={28} />
                    ) : (
                      <Music size={28} />
                    )}
                  </div>
                  <div className="flex-1 truncate">
                    <p className="text-[10px] font-black uppercase tracking-widest text-zinc-600 mb-1.5">
                      {mediaFile?.type.startsWith('video/') ? 'Video Content' : 'Audio Content'}
                    </p>
                    <p className="text-white font-bold truncate text-lg">
                      {mediaFile ? mediaFile.name : 'Choose File...'}
                    </p>
                  </div>
                  {mediaFile && (
                    <div className="p-2 bg-[#1DB954]/20 rounded-full">
                      <Check size={22} className="text-[#1DB954]" />
                    </div>
                  )}
                </div>

                <button
                  onClick={processTagger}
                  disabled={isProcessing || !mediaFile || !imageFile}
                  className={`w-full py-7 rounded-full flex flex-col items-center justify-center font-black text-2xl transition-all shadow-2xl active:scale-95 ${isProcessing || !mediaFile || !imageFile ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed' : 'bg-[#1DB954] text-black hover:bg-[#1ed760] hover:scale-[1.02]'}`}
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="animate-spin mb-1" size={32} />
                      <span className="text-[11px] uppercase tracking-[0.4em] opacity-70 font-black">
                        {processStep}
                      </span>
                    </>
                  ) : (
                    <>
                      <Download size={32} className="mb-1" />
                      <span>Export as MP3</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="animate-in fade-in zoom-in-95 duration-500">
              <input
                type="file"
                ref={bulkInputRef}
                onChange={(e) => addFilesToBulk(Array.from(e.target.files || []))}
                multiple
                accept="audio/*,video/*,image/*"
                className="hidden"
              />
              {bulkAudioFiles.length === 0 ? (
                <div
                  className="p-24 border-2 border-dashed border-zinc-800 rounded-[3.5rem] bg-zinc-900/30 text-center cursor-pointer hover:border-[#1DB954] transition-all group"
                  onClick={() => bulkInputRef.current?.click()}
                >
                  <Layers
                    size={96}
                    strokeWidth={1}
                    className="mx-auto mb-8 text-zinc-700 group-hover:text-[#1DB954] group-hover:scale-110 transition-all duration-500"
                  />
                  <p className="text-3xl font-black text-white">Batch Transcode</p>
                  <p className="text-zinc-500 text-base mt-4 font-medium max-w-sm mx-auto">
                    Drop files here. We'll match covers automatically by name and transcode everything
                    to MP3.
                  </p>
                </div>
              ) : (
                <div className="space-y-10">
                  <div className="flex items-center justify-between text-white px-2">
                    <h3 className="font-black text-3xl tracking-tight flex items-center gap-3">
                      Queue{' '}
                      <span className="bg-zinc-800 px-4 py-1 rounded-full text-zinc-400 text-lg">
                        {bulkAudioFiles.length}
                      </span>
                    </h3>
                    <button
                      onClick={() => bulkInputRef.current?.click()}
                      className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-full text-[11px] font-black uppercase tracking-widest transition-all hover:scale-105 active:scale-95 shadow-lg"
                    >
                      Add Files
                    </button>
                  </div>
                  <div className="max-h-[400px] overflow-y-auto custom-scrollbar pr-5 space-y-5">
                    {matchedPairs.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center gap-6 p-6 bg-zinc-800/20 rounded-[2rem] border border-zinc-800/40 hover:border-zinc-600 transition-all group hover:bg-zinc-800/30"
                      >
                        <div className="w-20 h-20 rounded-2xl bg-zinc-800 flex items-center justify-center border border-zinc-700 flex-shrink-0 overflow-hidden shadow-2xl relative">
                          {p.image ? (
                            <img src={URL.createObjectURL(p.image)} className="w-full h-full object-cover" />
                          ) : p.audio.type.startsWith('video/') ? (
                            <Video size={32} className="text-zinc-700" />
                          ) : (
                            <Music size={32} className="text-zinc-700" />
                          )}
                        </div>
                        <div className="flex-1 truncate">
                          <p className="text-lg font-bold text-white truncate mb-2">{p.audio.name}</p>
                          <div className="flex items-center gap-3">
                            <span
                              className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-[0.1em] ${p.image ? 'bg-[#1DB954]/15 text-[#1DB954]' : 'bg-red-500/15 text-red-400'}`}
                            >
                              {p.image ? (
                                <span className="flex items-center gap-1">
                                  <Check size={10} /> Cover Ready
                                </span>
                              ) : (
                                'No Match'
                              )}
                            </span>
                            <span className="text-[10px] font-black text-zinc-600 uppercase tracking-widest flex items-center gap-1">
                              <Sparkles size={10} /> MP3 192kbps
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            setBulkAudioFiles((prev) => prev.filter((f) => f.name !== p.audio.name))
                          }
                          className="p-4 text-zinc-700 hover:text-red-500 hover:bg-red-500/10 rounded-full transition-all opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 size={22} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={processTagger}
                    disabled={isProcessing || !matchedPairs.some((p) => p.image)}
                    className="w-full py-8 rounded-full bg-[#1DB954] text-black font-black text-2xl hover:bg-[#1ed760] transition-all shadow-[0_15px_40px_rgba(29,185,84,0.3)] active:scale-95 hover:scale-[1.01]"
                  >
                    {isProcessing ? (
                      <div className="flex flex-col items-center">
                        <Loader2 className="animate-spin mb-1" size={32} />
                        <span className="text-[11px] opacity-70 uppercase tracking-[0.4em] font-black">
                          {processStep || 'Transcoding...'}
                        </span>
                      </div>
                    ) : (
                      `Start Processing (${matchedPairs.filter((p) => p.image).length})`
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {(mediaFile || bulkAudioFiles.length > 0) && !isProcessing && (
            <button
              onClick={() => {
                setMediaFile(null);
                setImageFile(null);
                setImagePreview(null);
                setBulkAudioFiles([]);
                setBulkImageFiles([]);
                setManualAssignments({});
              }}
              className="w-full mt-12 text-zinc-600 hover:text-white text-[11px] font-black uppercase tracking-[0.3em] flex items-center justify-center gap-4 transition-colors group"
            >
              <ArrowLeft size={18} className="group-hover:-translate-x-1 transition-transform" /> Reset
              Engine
            </button>
          )}
        </div>

        <footer className="mt-16 text-center text-zinc-600">
          <p className="text-[11px] font-black uppercase tracking-[0.3em] opacity-50">
            Studio Quality • Privacy-First • No Uploads Required
          </p>
        </footer>
      </main>
    </div>
  );
};

export default App;
