/**
 * REST API Яндекс Музыки (неофициальное): мета-данные трека и лайки.
 * Токен — OAuth Яндекс Музыки.
 */
const API = 'https://api.music.yandex.ru';

function headers(token) {
  return {
    Authorization: `OAuth ${token}`,
    'X-Yandex-Music-Client': 'YandexMusicDesktop/5.64.0',
    'User-Agent': 'YMMusicWidget/1.0',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

class YMApi {
  constructor(token) {
    this.token = token;
    this.uid = null;
    this.likedSet = null;
    this.likedCacheAt = 0;
  }

  async _get(ep) {
    const r = await fetch(API + ep, { headers: headers(this.token) });
    if (!r.ok) throw new Error(`GET ${ep} -> ${r.status}`);
    return r.json();
  }

  async _post(ep) {
    const r = await fetch(API + ep, {
      method: 'POST',
      headers: headers(this.token),
      body: '',
    });
    if (!r.ok) throw new Error(`POST ${ep} -> ${r.status}`);
    return r.json();
  }

  async getUid() {
    if (this.uid) return this.uid;
    const st = await this._get('/account/status');
    const acc = ((st && st.result) || st || {}).account || {};
    this.uid = acc.uid;
    if (!this.uid) throw new Error('account/status: нет uid');
    return this.uid;
  }

  /** Мета данных трека */
  async getTrack(id) {
    const wrap = await this._get(`/tracks/${id}`);
    const list = wrap && Array.isArray(wrap.result) ? wrap.result : Array.isArray(wrap) ? wrap : [];
    const t = list[0] || null;
    if (!t) return null;
    const artists = (t.artists || []).map((a) => a.name).filter(Boolean).join(', ');
    let cover = null;
    if (t.coverUri) {
      const uri = t.coverUri;
      cover = (
        uri.startsWith('//') ? 'https:' + uri
        : /^https?:\/\//.test(uri) ? uri
        : 'https://' + uri
      ).replace('%%', '400x400');
    }
    return {
      id: t.id,
      title: t.title || null,
      artists,
      album: t.albums && t.albums[0] ? t.albums[0].title : null,
      cover,
      durationMs: t.durationMs || 0,
    };
  }

  /** Список лайкнутых треков (с кэшем 5 минут) */
  async getLikedIds() {
    if (this.likedSet && Date.now() - this.likedCacheAt < 5 * 60000) return this.likedSet;
    const uid = await this.getUid();
    const j = await this._get(`/users/${uid}/likes/tracks`);
    const lib = (j && j.result && j.result.library) || null;
    const list = (lib && lib.tracks) || [];
    const ids = new Set(list.map((x) => (x && x.id != null ? String(x.id) : '')).filter(Boolean));
    this.likedSet = ids;
    this.likedCacheAt = Date.now();
    return ids;
  }

    /** Поиск трека по названию (для SMTC-источника), с кэшем успешных результатов */
    async findTrack(title, artists) {
      const key = (artists || '') + '|' + (title || '');
      if (this._searchCache) {
        const hit = this._searchCache.get(key);
        if (hit !== undefined) return hit;
      }
      if (!this._searchCache) this._searchCache = new Map();
      if (!title) return null;
      try {
        const j = await this._get('/search?text=' + encodeURIComponent((artists ? artists + ' ' : '') + title) + '&type=track&page=0&pageSize=3');
        const r = (j && j.result) || j || {};
        const res = r.tracks && r.tracks.results && r.tracks.results[0];
        if (res && res.id) {
          this._searchCache.set(key, String(res.id));
          return String(res.id);
        }
      } catch (e) {
        console.error('[api] поиск: ' + e.message);
      }
      return null;
    }

  /** Общая информация об альбоме (нужны артисты для CDP-источника) */
  async getAlbum(id) {
    const j = await this._get('/albums/' + id);
    const a = j && (j.result || j);
    if (!a || !a.artists) return null;
    return {
      title: a.title || null,
      artists: a.artists.map((x) => x.name).filter(Boolean).join(', '),
      cover: a.coverUri ? ('https:' + a.coverUri).replace('%%', '400x400') : null,
    };
  }

  async setLike(trackId, liked) {
    const uid = await this.getUid();
    const op = liked ? 'add-multiple' : 'remove-multiple';
    await this._post(`/users/${uid}/likes/tracks/${op}?track-ids=${trackId}`);
    if (this.likedSet) {
      if (liked) this.likedSet.add(String(trackId).replace(/\D+$/, ''));
      else this.likedSet.delete(String(trackId).replace(/\D+$/, ''));
      this.likedCacheAt = Date.now();
    }
  }
}

module.exports = { YMApi };
