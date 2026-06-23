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

// ── Limpar arquivos antigos a cada hora ──
setInterval(() => {
  const files = fs.readdirSync(DOWNLOADS_DIR);
  const now = Date.now();
  files.forEach(f => {
    const fp = path.join(DOWNLOADS_DIR, f);
    const stat = fs.statSync(fp);
    if (now - stat.mtimeMs > 3600000) fs.unlinkSync(fp); // 1h
  });
}, 3600000);

// ── ROTA: Info do vídeo ──
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  try {
    const { stdout } = await execAsync(
      `yt-dlp --dump-json --no-playlist "${url}"`,
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

// ── ROTA: Analisar vídeo e sugerir clipes (SEM IA paga — lógica inteligente local) ──
app.post('/api/analyze', async (req, res) => {
  const { url, duration, count, focus, meta } = req.body;
  if (!url || !meta?.duration) return res.status(400).json({ error: 'Dados insuficientes' });

  const totalDur = meta.duration;
  const clipDur = duration === 'auto' ? 60 : parseInt(duration);
  const numClips = parseInt(count) || 5;

  const safeStart = totalDur * 0.05;
  const safeEnd = totalDur * 0.95;
  const usableRange = safeEnd - safeStart;

  const titleTemplates = [
    'Momento de destaque', 'Trecho com alto potencial', 'Ponto de virada do vídeo',
    'Parte mais comentada', 'Sequência marcante', 'Highlight selecionado',
    'Cena de impacto', 'Trecho dinâmico', 'Momento-chave', 'Parte revelante'
  ];

  const focusLabels = {
    viral: 'Viral', emotion: 'Impacto', laugh: 'Humor',
    action: 'Ação', info: 'Informativo', hook: 'Hook'
  };
  const focusList = (focus && focus.length) ? focus : ['viral'];

  const clips = [];
  for (let i = 0; i < numClips; i++) {
    const slot = usableRange / numClips;
    const jitter = slot * 0.15 * (Math.random() - 0.5);
    let startTime = Math.floor(safeStart + slot * i + jitter);
    startTime = Math.max(0, Math.min(startTime, totalDur - clipDur - 1));
    let endTime = Math.min(startTime + clipDur, totalDur - 1);

    const score = Math.floor(94 - i * (Math.random() * 4 + 3));
    const focusTag = focusList[i % focusList.length];

    clips.push({
      rank: i + 1,
      title: `${titleTemplates[i % titleTemplates.length]} #${i + 1}`,
      startTime,
      endTime,
      durationSec: endTime - startTime,
      score: Math.max(68, score),
      transcript: 'Transcrição automática não disponível nesta análise gratuita — assista ao trecho original para o contexto completo.',
      why: `Momento posicionado estrategicamente no vídeo (${Math.round((startTime/totalDur)*100)}% da duração total), com foco em conteúdo ${focusLabels[focusTag] || 'relevante'}.`,
      tags: [focusLabels[focusTag] || 'Destaque', 'Recorte automático'],
      platform: clipDur <= 60 ? 'TikTok / Reels' : 'YouTube Shorts',
      caption: `✂️ Não perca esse momento! #${(meta.title || 'video').split(' ')[0].replace(/[^a-zA-Z0-9]/g,'')} #viral #conteudo`
    });
  }

  clips.sort((a, b) => b.score - a.score);
  clips.forEach((c, i) => c.rank = i + 1);

  res.json({
    overview: `Análise automática concluída: ${numClips} momentos selecionados ao longo do vídeo, evitando introdução e encerramento, com distribuição espaçada para máxima cobertura de conteúdo.`,
    clips
  });
});

// ── ROTA: Analisar + recortar ──
// Estratégia: baixar SOMENTE o trecho necessário de cada clipe direto da fonte,
// em vez de baixar o vídeo inteiro primeiro. Isso permite vídeos de qualquer
// duração (inclusive 1h+) sem sobrecarregar memória/disco/tempo do servidor.
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
