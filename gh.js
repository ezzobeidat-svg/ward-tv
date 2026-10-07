// ===== שמירה ב-GitHub – משותף לדף הצוות ולדף הנוכחות =====
(function () {
  const CFG = Object.assign({ OWNER: '', REPO: '', BRANCH: 'main', DATA_PATH: 'data.json', TOKEN_ENC: '' }, window.CONFIG || {});
  const GH = 'https://api.github.com';
  const DEMO = !CFG.TOKEN_ENC;
  let TOKEN = '', WHO = '';

  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const uid = () => Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 7);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function b64e(str) { const b = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return btoa(s); }
  function b64d(b64) { const bin = atob(String(b64).replace(/\s/g, '')); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); }

  async function decryptToken(enc, code) {
    const o = typeof enc === 'string' ? JSON.parse(enc) : enc;
    const ub = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: ub(o.s), iterations: o.n || 310000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub(o.i) }, key, ub(o.c)));
  }

  const headers = () => ({ Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json' });
  const fileUrl = p => `${GH}/repos/${CFG.OWNER}/${CFG.REPO}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;

  const demoStore = {
    get() { try { return JSON.parse(localStorage.getItem('ward-demo') || '[]'); } catch (e) { return []; } },
    set(v) { localStorage.setItem('ward-demo', JSON.stringify(v)); }
  };

  async function getData() {
    const r = await fetch(`${fileUrl(CFG.DATA_PATH)}?ref=${encodeURIComponent(CFG.BRANCH)}`, { headers: headers(), cache: 'no-store' });
    if (r.status === 404) return { sha: null, items: [] };
    if (r.status === 401) throw 'הטוקן לא תקין או שפג תוקפו';
    if (!r.ok) throw 'שגיאת GitHub ' + r.status;
    const j = await r.json();
    const d = JSON.parse(b64d(j.content) || '{"items":[]}');
    return { sha: j.sha, items: d.items || [] };
  }

  function prune(items) {
    const c = new Date(); c.setDate(c.getDate() - 30); const cut = ymd(c);
    return items.filter(i => !((i.type === 'attendance' && i.date && i.date < cut) || (i.type !== 'image' && i.end && i.end < cut)));
  }
  function stamp(it) { return Object.assign({}, it, { id: it.id || uid(), by: WHO, updated: new Date().toISOString() }); }

  // שינוי בטוח של data.json: קורא את הגרסה האחרונה, מחיל את השינוי ושומר. אם מישהו שמר באותו רגע – מנסה שוב.
  async function mutate(fn, label) {
    if (DEMO) { const items = prune(fn(demoStore.get().slice())); demoStore.set(items); return items; }
    for (let t = 0; t < 5; t++) {
      const cur = await getData();
      const items = prune(fn(cur.items.slice()));
      const r = await fetch(fileUrl(CFG.DATA_PATH), {
        method: 'PUT', headers: headers(), body: JSON.stringify({
          message: `${label || 'עדכון'} – ${WHO}`,
          content: b64e(JSON.stringify({ updated: new Date().toISOString(), items }, null, 1)),
          branch: CFG.BRANCH, ...(cur.sha ? { sha: cur.sha } : {})
        })
      });
      if (r.ok) return items;
      if (r.status === 409 || r.status === 422) { await sleep(400 + Math.random() * 900); continue; }
      if ([401, 403, 404].includes(r.status)) throw 'אין הרשאת כתיבה (בדקו את הטוקן)';
      throw 'GitHub ' + r.status;
    }
    throw 'עומס – נסו שוב';
  }

  const W = window.WardGH = {
    CFG, DEMO, ymd, uid,
    setWho(w) { WHO = w; },
    async unlock(code) {
      if (DEMO) return true;
      if (!CFG.OWNER || !CFG.REPO) throw 'חסרים OWNER / REPO בקובץ config.js';
      try { TOKEN = await decryptToken(CFG.TOKEN_ENC, code); } catch (e) { throw 'קוד שגוי'; }
      return true;
    },
    async load() {
      if (DEMO) return demoStore.get();
      return (await getData()).items;
    },
    save(list, label) {
      list = [].concat(list).map(stamp);
      return mutate(items => {
        list.forEach(it => { const i = items.findIndex(x => x.id === it.id); if (i >= 0) items[i] = it; else items.push(it); });
        return items;
      }, label || ('עדכון ' + (list[0] && list[0].type || '')));
    },
    del(ids, label) {
      ids = [].concat(ids);
      return mutate(items => items.filter(x => !ids.includes(x.id)), label || 'מחיקה');
    },
    // העלאת קובץ (תמונה) לתיקיית images ב-repo
    async uploadFile(path, base64, label) {
      if (DEMO) return path;
      const r = await fetch(fileUrl(path), {
        method: 'PUT', headers: headers(),
        body: JSON.stringify({ message: `${label || 'תמונה'} – ${WHO}`, content: base64, branch: CFG.BRANCH })
      });
      if (!r.ok) throw 'העלאה נכשלה (' + r.status + ')';
      return path;
    },
    async deleteFile(path) {
      if (DEMO || !/^images\//.test(path)) return;
      try {
        const g = await fetch(`${fileUrl(path)}?ref=${encodeURIComponent(CFG.BRANCH)}`, { headers: headers(), cache: 'no-store' });
        if (!g.ok) return;
        const j = await g.json();
        await fetch(fileUrl(path), { method: 'DELETE', headers: headers(), body: JSON.stringify({ message: `מחיקת תמונה – ${WHO}`, sha: j.sha, branch: CFG.BRANCH }) });
      } catch (e) { }
    },
    // תצוגה מקדימה של תמונה (גם לפני ש-GitHub Pages מתעדכן)
    imgSrc(url) {
      if (!url || /^(https?:|data:)/.test(url)) return url;
      return CFG.OWNER ? `https://raw.githubusercontent.com/${CFG.OWNER}/${CFG.REPO}/${CFG.BRANCH}/${url}` : url;
    }
  };

  // הקטנת תמונה לפני העלאה (טלפונים מצלמים בגודל ענק)
  W.resizeImage = function (file, maxW, maxH, q) {
    return new Promise((res, rej) => {
      const img = new Image(), u = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        x.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(u);
        const dataUrl = c.toDataURL('image/jpeg', q || 0.85);
        res({ dataUrl, base64: dataUrl.split(',')[1], w: c.width, h: c.height });
      };
      img.onerror = () => { URL.revokeObjectURL(u); rej('לא ניתן לקרוא את הקובץ ' + file.name); };
      img.src = u;
    });
  };
})();
