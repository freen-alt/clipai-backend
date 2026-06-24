const express = require('express');
const cors = require('cors');
const { exec, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// ── Limpar arquivos e pastas antigos a cada hora (nunca derruba o servidor) ──
setInterval(() => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const now = Date.now();
    files.forEach(f => {
      try {
        const fp = path.join(DOWNLOADS_DIR, f);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 3600000) {
          if (stat.isDirectory()) {
            fs.rmSync(fp, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fp);
          }
        }
      } catch (innerErr) {
        console.error('Erro ao limpar item:', f, innerErr.message);
      }
    });
  } catch (err) {
    console.error('Erro na limpeza periódica:', err.message);
  }
}, 3600000);

// ── Captura erros não tratados para o servidor NUNCA cair por completo ──
process.on('uncaughtException', (err) => {
  console.error('Erro não tratado capturado (servidor continua rodando):', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Promise rejeitada não tratada (servidor continua rodando):', err);
});

// ── ROTA: Info do vídeo ──
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  try {
    const { stdout } = await execAsync(
      `yt-dlp --dump-json --no-playlist --extractor-args "youtube:player_client=android" "${url}"`,
      { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }
    );
    const info = JSON.parse(stdout);
    res.json({
      title: info.title,
      duration: info.duration,
      thumbnail: info.thumbnail,
      uploader: info.uploader,
      platform: info.extractor_key,
      formats: info.formats?.length || 0
    });
  } catch (e) {
    res.status(500).json({ error: 'Não foi possível acessar o vídeo. Verifique o link.' });
  }
});

// ── ROTA: Analisar vídeo com TRANSCRIÇÃO REAL (Whisper, gratuito) ──
app.post('/api/analyze', async (req, res) => {
  const { url, duration, count, focus, meta } = req.body;
  if (!url || !meta?.duration) return res.status(400).json({ error: 'Dados insuficientes' });

  const totalDur = meta.duration;
  const clipDur = duration === 'auto' ? 60 : parseInt(duration);
  const numClips = parseInt(count) || 5;

  const jobId = 'analyze_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const jobDir = path.join(DOWNLOADS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const audioPath = path.join(jobDir, 'audio.m4a');

  try {
    await execAsync(
      `yt-dlp -f "bestaudio[ext=m4a]/bestaudio" --extractor-args "youtube:player_client=android" ` +
      `-o "${audioPath}" --no-playlist "${url}"`,
      { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }
    );

    if (!fs.existsSync(audioPath)) throw new Error('Áudio não foi baixado');

    const { stdout } = await execAsync(
      `python3 ${path.join(__dirname, 'transcribe.py')} "${audioPath}"`,
      { timeout: 600000, maxBuffer: 100 * 1024 * 1024 }
    );

    const transcription = JSON.parse(stdout);
    if (transcription.error) throw new Error(transcription.error);

    const segments = transcription.segments || [];
    if (segments.length === 0) throw new Error('Transcrição vazia');

    const clips = selectBestClips(segments, totalDur, clipDur, numClips, focus, meta);

    fs.rmSync(jobDir, { recursive: true, force: true });

    res.json({
      overview: `Transcrição completa analisada: ${numClips} momentos identificados com base no conteúdo real falado no vídeo, priorizando frases de impacto e cortes em pontos naturais de fala.`,
      clips
    });
  } catch (e) {
    fs.rmSync(jobDir, { recursive: true, force: true });
    const clips = fallbackClipSelection(totalDur, clipDur, numClips, focus, meta);
    res.json({
      overview: `Não foi possível transcrever o áudio (${e.message.slice(0,100)}). Usando seleção automática por distribuição no vídeo.`,
      clips
    });
  }
});

function selectBestClips(segments, totalDur, clipDur, numClips, focus, meta) {
  const focusLabels = {
    viral: 'Viral', emotion: 'Impacto', laugh: 'Humor',
    action: 'Ação', info: 'Informativo', hook: 'Hook'
  };
  const focusList = (focus && focus.length) ? focus : ['viral'];

  const impactWords = [
    'incrível', 'nunca', 'jamais', 'impossível', 'chocante', 'surpreendente',
    'descobri', 'segredo', 'verdade', 'mentira', 'erro', 'aprendi',
    'importante', 'cuidado', 'atenção', 'olha', 'gente', 'sério',
    'não acredito', 'engraçado', 'hilário', 'triste', 'emocionante',
    'melhor', 'pior', 'primeira vez', 'última vez', 'mudou', 'mudei',
    '?', '!'
  ];

  const candidates = [];
  const safeStartTime = totalDur * 0.03;
  const safeEndTime = totalDur * 0.97;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.start < safeStartTime || seg.start > safeEndTime) continue;

    let blockEnd = seg.start;
    let blockText = '';
    let j = i;
    while (j < segments.length && (segments[j].end - seg.start) <= clipDur * 1.15) {
      blockText += ' ' + segments[j].text;
      blockEnd = segments[j].end;
      j++;
    }
    const blockDuration = blockEnd - seg.start;
    if (blockDuration < clipDur * 0.6) continue;

    const lowerText = blockText.toLowerCase();
    let contentScore = 0;
    impactWords.forEach(w => {
      if (lowerText.includes(w)) contentScore += 1;
    });

    const wordCount = blockText.trim().split(/\s+/).length;
    const density = wordCount / blockDuration;

    candidates.push({
      startTime: Math.round(seg.start),
      endTime: Math.round(Math.min(blockEnd, seg.start + clipDur)),
      text: blockText.trim(),
      contentScore,
      density,
      finalScore: contentScore * 10 + density * 5
    });
  }

  candidates.sort((a, b) => b.finalScore - a.finalScore);

  const selected = [];
  for (const c of candidates) {
    if (selected.length >= numClips) break;
    const overlaps = selected.some(s =>
      (c.startTime < s.endTime && c.endTime > s.startTime)
    );
    if (!overlaps) selected.push(c);
  }

  while (selected.length < numClips) {
    selected.push(null);
  }

  const clips = selected.map((c, i) => {
    if (!c) {
      const startTime = Math.floor((totalDur / numClips) * i);
      return {
        rank: i + 1,
        title: `Momento adicional #${i + 1}`,
        startTime,
        endTime: Math.min(startTime + clipDur, totalDur - 1),
        durationSec: clipDur,
        score: 65,
        transcript: 'Trecho sem transcrição clara disponível.',
        why: 'Momento complementar selecionado para completar a quantidade solicitada.',
        tags: ['Complementar'],
        platform: clipDur <= 60 ? 'TikTok / Reels' : 'YouTube Shorts',
        caption: `✂️ #conteudo #viral`
      };
    }
    const score = Math.min(97, Math.max(70, Math.round(75 + c.finalScore)));
    const focusTag = focusList[i % focusList.length];
    return {
      rank: i + 1,
      title: c.text.length > 55 ? c.text.slice(0, 52) + '...' : (c.text || `Momento #${i+1}`),
      startTime: c.startTime,
      endTime: c.endTime,
      durationSec: c.endTime - c.startTime,
      score,
      transcript: c.text || 'Transcrição não disponível para este trecho.',
      why: `Trecho com ${c.contentScore} elemento(s) de destaque identificado(s) na fala, com boa densidade de conteúdo falado. Foco: ${focusLabels[focusTag] || 'relevante'}.`,
      tags: [focusLabels[focusTag] || 'Destaque', 'Baseado em transcrição'],
      platform: clipDur <= 60 ? 'TikTok / Reels' : 'YouTube Shorts',
      caption: `✂️ ${c.text.slice(0, 60)}... #viral #conteudo`
    };
  });

  clips.sort((a, b) => b.score - a.score);
  clips.forEach((c, i) => c.rank = i + 1);

  return clips;
}

function fallbackClipSelection(totalDur, clipDur, numClips, focus, meta) {
  const safeStart = totalDur * 0.05;
  const safeEnd = totalDur * 0.95;
  const usableRange = safeEnd - safeStart;
  const focusLabels = {
    viral: 'Viral', emotion: 'Impacto', laugh: 'Humor',
    action: 'Ação', info: 'Informativo', hook: 'Hook'
  };
  const focusList = (focus && focus.length) ? focus : ['viral'];
  const clips = [];
  for (let i = 0; i < numClips; i++) {
    const slot = usableRange / numClips;
    let startTime = Math.floor(safeStart + slot * i);
    startTime = Math.max(0, Math.min(startTime, totalDur - clipDur - 1));
    let endTime = Math.min(startTime + clipDur, totalDur - 1);
    const focusTag = focusList[i % focusList.length];
    clips.push({
      rank: i + 1,
      title: `Momento de destaque #${i + 1}`,
      startTime, endTime,
      durationSec: endTime - startTime,
      score: Math.max(68, 90 - i * 4),
      transcript: 'Transcrição automática não disponível.',
      why: `Momento posicionado em ${Math.round((startTime/totalDur)*100)}% do vídeo.`,
      tags: [focusLabels[focusTag] || 'Destaque'],
      platform: clipDur <= 60 ? 'TikTok / Reels' : 'YouTube Shorts',
      caption: `✂️ Não perca esse momento! #viral #conteudo`
    });
  }
  return clips;
}

// ── ROTA: Analisar + recortar ──
app.post('/api/clip', async (req, res) => {
  const { url, clips } = req.body;
  if (!url || !clips?.length) return res.status(400).json({ error: 'Dados inválidos' });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const jobDir = path.join(DOWNLOADS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const results = [];

  for (const clip of clips) {
    const safeName = `clip_${clip.rank}_${clip.title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}`;
    const outPath = path.join(jobDir, safeName + '.mp4');
    const duration = clip.endTime - clip.startTime;
    const seekStart = Math.max(0, clip.startTime - 2);
    const offsetInClip = clip.startTime - seekStart;

    try {
      await execAsync(
        `yt-dlp -f "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best" ` +
        `--extractor-args "youtube:player_client=android" ` +
        `--download-sections "*${seekStart}-${clip.endTime + 2}" --force-keyframes-at-cuts ` +
        `--merge-output-format mp4 -o "${outPath}.raw.mp4" --no-playlist "${url}"`,
        { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }
      );

      const rawClipPath = outPath + '.raw.mp4';
      if (!fs.existsSync(rawClipPath)) throw new Error('Trecho não foi baixado');

      await execAsync(
        `ffmpeg -y -loglevel error -ss ${offsetInClip} -i "${rawClipPath}" -t ${duration} ` +
        `-c:v libx264 -preset veryfast -crf 26 -vf "scale='min(854,iw)':-2" -c:a aac -b:a 96k "${outPath}"`,
        { timeout: 90000, maxBuffer: 20 * 1024 * 1024 }
      );

      try { fs.unlinkSync(rawClipPath); } catch (e) {}

      if (!fs.existsSync(outPath)) throw new Error('Arquivo de saída não foi criado');
      const stat = fs.statSync(outPath);
      if (stat.size === 0) throw new Error('Arquivo gerado está vazio');

      results.push({
        rank: clip.rank,
        title: clip.title,
        filename: safeName + '.mp4',
        url: `/downloads/${jobId}/${safeName}.mp4`,
        sizeMb: (stat.size / 1024 / 1024).toFixed(1),
        durationSec: duration
      });
    } catch (e) {
      const msg = (e.stderr || e.message || 'erro desconhecido').toString().slice(0, 200);
      results.push({ rank: clip.rank, title: clip.title, error: 'Falha ao recortar: ' + msg });
      try { fs.unlinkSync(outPath + '.raw.mp4'); } catch (e) {}
    }
  }

  res.json({ jobId, clips: results });
});

// ── ROTA: Status ──
app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ ClipAI Backend rodando na porta ${PORT}`));
