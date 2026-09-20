import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import axios, { AxiosResponse } from 'axios';

// ─── Rate-limiting y cola de peticiones a Tenrai ─────────────────────────────
// Tenrai/Jikan limita a ~3 req/s. Encolamos y reintentamos ante 429/5xx.

const TENRAI_BASE = 'https://api.tenrai.org/v1';
const MAX_INTENTOS = 3;
const REINTENTABLES = [429, 503, 504];
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms));

let cola: Promise<unknown> = Promise.resolve();

// ─── Tipos internos de la API de Tenrai ──────────────────────────────────────

interface ApiNamed {
  mal_id: number;
  name: string;
  type?: string;
}

interface ApiImages {
  jpg?: {
    image_url?: string;
    small_image_url?: string;
    large_image_url?: string;
  };
}

interface ApiAnime {
  mal_id: number;
  title: string;
  title_english?: string | null;
  title_japanese?: string | null;
  score?: number | null;
  scored_by?: number | null;
  rank?: number | null;
  popularity?: number | null;
  members?: number | null;
  type?: string | null;
  year?: number | null;
  episodes?: number | null;
  status?: string | null;
  source?: string | null;
  rating?: string | null;
  duration?: string | null;
  synopsis?: string | null;
  images?: ApiImages;
  trailer?: { youtube_id?: string | null };
  aired?: { prop?: { from?: { year?: number | null } } };
  studios?: ApiNamed[];
  genres?: ApiNamed[];
  themes?: ApiNamed[];
  demographics?: ApiNamed[];
  theme?: { openings?: string[]; endings?: string[] };
  streaming?: { name?: string; url?: string }[];
  external?: { name?: string; url?: string }[];
}

interface ApiManga {
  mal_id: number;
  title: string;
  title_english?: string | null;
  title_japanese?: string | null;
  score?: number | null;
  scored_by?: number | null;
  rank?: number | null;
  popularity?: number | null;
  type?: string | null;
  published?: { prop?: { from?: { year?: number | null } } };
  volumes?: number | null;
  chapters?: number | null;
  status?: string | null;
  synopsis?: string | null;
  images?: ApiImages;
  genres?: ApiNamed[];
  themes?: ApiNamed[];
  demographics?: ApiNamed[];
  authors?: { person?: { name?: string } }[];
  external?: { name?: string; url?: string }[];
}

interface ApiCharacter {
  character?: { mal_id?: number; name?: string; images?: ApiImages };
  role?: string;
  voice_actors?: { person?: { name?: string } }[];
}

interface ApiEpisode {
  mal_id?: number;
  title?: string;
  aired?: string | null;
}

interface ApiRelation {
  relation?: string;
  entry?: { mal_id?: number; type?: string; name?: string; url?: string }[];
}

interface ApiRecommendation {
  entry?: {
    mal_id?: number;
    images?: ApiImages;
    title?: string;
  };
}

interface JikanEntrada {
  mal_id: number;
  title: string;
  images?: ApiImages;
  type?: string | null;
  year?: number | null;
  aired?: { prop?: { from?: { year?: number | null } } };
  published?: { prop?: { from?: { year?: number | null } } };
  score?: number | null;
  status?: string | null;
  genres?: { name: string }[];
  themes?: { name: string }[];
  synopsis?: string | null;
  episodes?: number | null;
  chapters?: number | null;
}

interface JikanNoticia {
  mal_id: number;
  title: string;
  excerpt?: string;
  images?: ApiImages;
  author_username?: string;
  date?: string;
  url?: string;
}

// ─── Tipos de respuesta (mismos shapes que espera el frontend) ───────────────

export interface CatalogoItem {
  id: number;
  title: string;
  img: string;
  type: string;
  year: number | null;
  score: number | null;
  status: string;
  genres: string[];
  synopsis: string | null;
  total: number | null;
}

export interface CatalogoRespuesta {
  items: CatalogoItem[];
  paginaActual: number;
  ultimaPagina: number;
  total: number;
}

export interface Personaje {
  nombre: string;
  rol: string;
  img?: string;
  seiyuu?: string;
}

export interface Episodio {
  num: number;
  titulo: string;
  fecha: string;
}

export interface LinkExterno {
  nombre: string;
  url: string;
}

export interface AnimeCard {
  id: number;
  title: string;
  year: number;
  score: number;
  type: string;
  img: string;
}

export interface AnimeDetalle {
  id: number;
  titulo: string;
  tituloIngles?: string;
  score: number;
  votos: number;
  rank: number;
  popularidad: number;
  tipo: string;
  year: number;
  estudio: string;
  eps: number;
  estado: string;
  fuente: string;
  clasificacion: string;
  duracion: string;
  generos: string[];
  sinopsis: string;
  img: string;
  banner: string;
  trailerYtId?: string;
  openings: string[];
  endings: string[];
  personajes: Personaje[];
  episodios: Episodio[];
  relacionados: AnimeCard[];
  similares: AnimeCard[];
  streaming: LinkExterno[];
  externales: LinkExterno[];
}

export interface MangaDetalle {
  id: number;
  titulo: string;
  tituloIngles?: string;
  tituloJapones?: string;
  score: number;
  votos: number;
  rank: number;
  popularidad: number;
  tipo: string;
  year: number;
  volumenes: number;
  capitulos: number;
  estado: string;
  fuente: string;
  generos: string[];
  sinopsis: string;
  img: string;
  autores: string[];
  personajes: Personaje[];
  relacionados: AnimeCard[];
  similares: AnimeCard[];
  externales: LinkExterno[];
}

export interface PopularItem {
  id: number;
  title: string;
  type: string;
  synopsis: string | null;
  genres: string[];
  year: number | null;
  count: number | null;
  countLabel: string;
  img: string;
  medio?: 'anime' | 'manga';
}

export interface Noticia {
  id: number;
  titulo: string;
  extracto: string;
  img: string;
  fuente: string;
  fecha: string;
  url: string;
}

export interface HeroItem {
  id: number;
  title: string;
  altTitle: string;
  score: number;
  type: string;
  year: number;
  studio: string;
  eps: number;
  genres: string[];
  synopsis: string;
  img: string;
}

@Injectable()
export class CatalogoService {
  private readonly logger = new Logger(CatalogoService.name);

  // Caché general de respuestas crudas de Tenrai (keyed por URL completa)
  private cacheTenrai = new Map<string, { datos: unknown; expira: number }>();
  // Deduplicación: si la misma URL ya está en vuelo, reutilizar la promesa
  private enVuelo = new Map<string, Promise<unknown>>();

  constructor(private readonly prisma: PrismaService) {}

  // ─── PETICIÓN CON RATE-LIMITING + CACHÉ + DEDUPLICACIÓN ────────────────────

  private async pedirTenrai<T>(endpoint: string, ttlMs = 5 * 60 * 1000): Promise<T> {
    const url = `${TENRAI_BASE}${endpoint}`;
    const ahora = Date.now();

    // 1. Si está cacheado y no expiró, devolver directo
    const cacheado = this.cacheTenrai.get(url);
    if (cacheado && cacheado.expira > ahora) {
      return cacheado.datos as T;
    }

    // 2. Si la misma URL ya está en vuelo, reutilizar la promesa (dedup)
    const existente = this.enVuelo.get(url);
    if (existente) {
      return existente as Promise<T>;
    }

    // 3. Encolar con reintentos
    const ejecutar = async (): Promise<T> => {
      for (let i = 0; i < MAX_INTENTOS; i++) {
        try {
          const res: AxiosResponse<T> = await axios.get(url, { timeout: 15000 });
          this.cacheTenrai.set(url, { datos: res.data, expira: Date.now() + ttlMs });
          return res.data;
        } catch (err: unknown) {
          const status = (err as { response?: { status?: number } })?.response?.status;
          if (status && REINTENTABLES.includes(status) && i < MAX_INTENTOS - 1) {
            await esperar(1000 * Math.pow(2, i));
            continue;
          }
          // En 403, devolver dato stale si existe
          if (status === 403 && cacheado) {
            this.logger.warn(`Tenrai bloqueó ${endpoint}, usando caché stale`);
            return cacheado.datos as T;
          }
          throw err;
        }
      }
      throw new Error('La API de Tenrai no respondió tras los reintentos');
    };

    const promesa = cola.then(ejecutar);
    cola = promesa.then(() => esperar(500), () => esperar(500));

    this.enVuelo.set(url, promesa);
    promesa.finally(() => this.enVuelo.delete(url));

    return promesa;
  }

  // ─── HELPERS DE MAPEO ────────────────────────────────────────────────────

  private normalizarEntrada(e: JikanEntrada, medio: 'anime' | 'manga'): CatalogoItem {
    return {
      id: e.mal_id,
      title: e.title,
      img: e.images?.jpg?.large_image_url || e.images?.jpg?.image_url || '',
      type: e.type || (medio === 'anime' ? 'TV' : 'Manga'),
      year: e.year ?? e.aired?.prop?.from?.year ?? e.published?.prop?.from?.year ?? null,
      score: e.score ?? null,
      status: e.status || '',
      genres: [...(e.genres || []), ...(e.themes || [])].map(g => g.name),
      synopsis: e.synopsis ?? null,
      total: medio === 'anime' ? e.episodes ?? null : e.chapters ?? null,
    };
  }

  private mapearAnimeDetalle(a: ApiAnime): AnimeDetalle {
    const img = a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '';
    const generos = [
      ...(a.genres || []),
      ...(a.themes || []),
      ...(a.demographics || []),
    ].map(g => g.name);

    return {
      id: a.mal_id,
      titulo: a.title,
      tituloIngles: a.title_english ?? undefined,
      score: a.score ?? 0,
      votos: a.scored_by ?? 0,
      rank: a.rank ?? 0,
      popularidad: a.popularity ?? 0,
      tipo: a.type ?? 'TV',
      year: a.year ?? a.aired?.prop?.from?.year ?? 0,
      estudio: (a.studios || [])[0]?.name ?? '',
      eps: a.episodes ?? 0,
      estado: a.status ?? '',
      fuente: a.source ?? '',
      clasificacion: a.rating ?? '',
      duracion: a.duration ?? '',
      generos,
      sinopsis: a.synopsis ?? 'Sin sinopsis disponible.',
      img,
      banner: img,
      trailerYtId: a.trailer?.youtube_id ?? undefined,
      openings: a.theme?.openings ?? [],
      endings: a.theme?.endings ?? [],
      personajes: [],
      episodios: [],
      relacionados: [],
      similares: [],
      streaming: (a.streaming || []).map(s => ({ nombre: s.name ?? '', url: s.url ?? '' })),
      externales: (a.external || []).map(e => ({ nombre: e.name ?? '', url: e.url ?? '' })),
    };
  }

  private mapearMangaDetalle(m: ApiManga): MangaDetalle {
    const img = m.images?.jpg?.large_image_url || m.images?.jpg?.image_url || '';
    return {
      id: m.mal_id,
      titulo: m.title,
      tituloIngles: m.title_english ?? undefined,
      tituloJapones: m.title_japanese ?? undefined,
      score: m.score ?? 0,
      votos: m.scored_by ?? 0,
      rank: m.rank ?? 0,
      popularidad: m.popularity ?? 0,
      tipo: m.type ?? 'Manga',
      year: m.published?.prop?.from?.year ?? 0,
      volumenes: m.volumes ?? 0,
      capitulos: m.chapters ?? 0,
      estado: m.status ?? '',
      fuente: 'Manga',
      generos: [...(m.genres || []), ...(m.themes || []), ...(m.demographics || [])].map(g => g.name),
      sinopsis: m.synopsis ?? 'Sin sinopsis disponible.',
      img,
      autores: (m.authors || []).map(a => a.person?.name ?? '').filter(Boolean),
      personajes: [],
      relacionados: [],
      similares: [],
      externales: (m.external || []).map(e => ({ nombre: e.name ?? '', url: e.url ?? '' })),
    };
  }

  // ─── CATÁLOGO CON FILTROS ────────────────────────────────────────────────

  async buscarCatalogo(filtros: {
    medio: 'anime' | 'manga';
    q?: string;
    letra?: string;
    tipo?: string;
    genero?: string;
    anio?: string;
    temporada?: string;
    estado?: string;
    orden?: string;
    pagina?: number;
    sfw?: boolean;
  }): Promise<CatalogoRespuesta> {
    const p = new URLSearchParams();
    p.set('page', String(filtros.pagina || 1));
    p.set('limit', '20');
    p.set('sfw', filtros.sfw === false ? 'false' : 'true');
    if (filtros.q) p.set('q', filtros.q);
    if (filtros.letra) p.set('letter', filtros.letra);
    if (filtros.tipo) p.set('type', filtros.tipo.toLowerCase());
    if (filtros.genero) p.set('genres', filtros.genero);
    if (filtros.estado) p.set('status', filtros.estado);
    if (filtros.anio || filtros.temporada) {
      const anio = filtros.anio ? Number(filtros.anio) : new Date().getFullYear();
      const temporadas: Record<string, [number, number]> = {
        winter: [1, 3],
        spring: [4, 6],
        summer: [7, 9],
        fall: [10, 12],
      };
      const temp = temporadas[filtros.temporada ?? ''];
      if (temp) {
        const [m1, m2] = temp;
        const diaFin = new Date(anio, m2, 0).getDate();
        p.set('start_date', `${anio}-${String(m1).padStart(2, '0')}-01`);
        p.set('end_date', `${anio}-${String(m2).padStart(2, '0')}-${String(diaFin).padStart(2, '0')}`);
      } else {
        p.set('start_date', `${anio}-01-01`);
        p.set('end_date', `${anio}-12-31`);
      }
    }
    if (filtros.orden) {
      const [by, dir] = filtros.orden.split(':');
      p.set('order_by', by);
      p.set('sort', dir);
    }

    const json = await this.pedirTenrai<{
      data: JikanEntrada[];
      pagination?: {
        current_page?: number;
        last_visible_page?: number;
        items?: { total?: number };
      };
    }>(`/${filtros.medio}?${p.toString()}`);

    return {
      items: (json.data || []).map(e => this.normalizarEntrada(e, filtros.medio)),
      paginaActual: json.pagination?.current_page ?? 1,
      ultimaPagina: Math.min(json.pagination?.last_visible_page ?? 1, 100),
      total: json.pagination?.items?.total ?? (json.data || []).length,
    };
  }

  // ─── DETALLE DE ANIME ────────────────────────────────────────────────────

  async obtenerDetalleAnime(id: number): Promise<AnimeDetalle> {
    // /full ya incluye relations y recommendations inline — no necesitamos endpoints separados
    const [{ data: base }, { data: personajes }, { data: episodios }] =
      await Promise.all([
        this.pedirTenrai<{ data: ApiAnime & { relations?: ApiRelation[]; recommendations?: ApiRecommendation[] } }>(
          `/anime/${id}/full`,
        ),
        this.pedirTenrai<{ data: ApiCharacter[] }>(`/anime/${id}/characters`),
        this.pedirTenrai<{ data: ApiEpisode[] }>(`/anime/${id}/episodes`),
      ]);

    const detalle = this.mapearAnimeDetalle(base);

    detalle.personajes = (personajes || []).slice(0, 12).map(c => ({
      nombre: c.character?.name ?? 'Personaje',
      rol: c.role ?? '',
      img: c.character?.images?.jpg?.image_url,
      seiyuu: c.voice_actors?.[0]?.person?.name,
    }));

    detalle.episodios = (episodios || []).map(ep => ({
      num: ep.mal_id ?? 0,
      titulo: ep.title ?? `Episodio ${ep.mal_id ?? ''}`,
      fecha: ep.aired ?? '',
    }));

    // Relacionados: extraer IDs del /full, traer info de cada uno (max 5)
    const idsRelacionados = ((base as unknown as { relations?: ApiRelation[] }).relations || [])
      .flatMap(r => (r.entry || []).filter(e => e.type === 'anime').map(e => e.mal_id))
      .filter((v): v is number => v != null && v > 0)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 5);

    detalle.relacionados = (
      await Promise.allSettled(
        idsRelacionados.map(async relId => {
          const { data: rel } = await this.pedirTenrai<{ data: ApiAnime }>(`/anime/${relId}`);
          return {
            id: relId,
            title: rel.title || 'Sin título',
            year: rel.year ?? rel.aired?.prop?.from?.year ?? 0,
            score: rel.score ?? 0,
            type: rel.type || 'TV',
            img: rel.images?.jpg?.large_image_url || rel.images?.jpg?.image_url || '',
          };
        }),
      )
    )
      .filter((r): r is PromiseFulfilledResult<AnimeCard> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(r => r.img);

    // Similares: extraer del /full (ya incluye images + title, sin fetch extra)
    detalle.similares = ((base as unknown as { recommendations?: ApiRecommendation[] }).recommendations || [])
      .slice(0, 5)
      .map(r => ({
        id: r.entry?.mal_id ?? 0,
        title: r.entry?.title ?? '',
        year: 0,
        score: 0,
        type: 'TV',
        img: r.entry?.images?.jpg?.large_image_url || r.entry?.images?.jpg?.image_url || '',
      }))
      .filter(r => r.id > 0);

    return detalle;
  }

  // ─── DETALLE DE MANGA ────────────────────────────────────────────────────

  async obtenerDetalleManga(id: number): Promise<MangaDetalle> {
    // /full ya incluye recommendations inline
    const [{ data: base }, { data: personajes }] = await Promise.all([
      this.pedirTenrai<{ data: ApiManga & { recommendations?: ApiRecommendation[] } }>(`/manga/${id}/full`),
      this.pedirTenrai<{ data: ApiCharacter[] }>(`/manga/${id}/characters`),
    ]);

    const detalle = this.mapearMangaDetalle(base);

    detalle.personajes = (personajes || []).slice(0, 12).map(c => ({
      nombre: c.character?.name ?? 'Personaje',
      rol: c.role ?? '',
      img: c.character?.images?.jpg?.image_url,
      seiyuu: c.voice_actors?.[0]?.person?.name,
    }));

    // Similares: del /full (ya incluye images + title, sin fetch extra)
    detalle.similares = ((base as unknown as { recommendations?: ApiRecommendation[] }).recommendations || [])
      .slice(0, 5)
      .map(r => ({
        id: r.entry?.mal_id ?? 0,
        title: r.entry?.title ?? '',
        year: 0,
        score: 0,
        type: 'Manga',
        img: r.entry?.images?.jpg?.large_image_url || r.entry?.images?.jpg?.image_url || '',
      }))
      .filter(r => r.id > 0);

    return detalle;
  }

  // ─── DATOS PARA LA HOME (con caché en memoria) ───────────────────────────

  private cacheHome = new Map<string, { datos: unknown; expira: number }>();

  private async obtenerConCache<T>(clave: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const ahora = Date.now();
    const cacheado = this.cacheHome.get(clave);
    if (cacheado && cacheado.expira > ahora) {
      return cacheado.datos as T;
    }
    const datos = await fn();
    this.cacheHome.set(clave, { datos, expira: ahora + ttlMs });
    return datos;
  }

  async obtenerHero(): Promise<HeroItem[]> {
    return this.obtenerConCache('hero', 8 * 60 * 60 * 1000, async () => {
      const registros = await this.prisma.hero_anime.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        take: 5,
      });

      return registros.map(r => ({
        id: r.tenraiId,
        title: r.titulo,
        altTitle: r.tituloIngles ?? '',
        score: r.puntuacion,
        type: r.tipo,
        year: r.anio,
        studio: r.estudio,
        eps: r.episodios,
        genres: r.generos,
        synopsis: r.sinopsis,
        img: r.imgUrl,
      }));
    });
  }

  async obtenerEnTemporada(): Promise<CatalogoItem[]> {
    return this.obtenerConCache('temporada', 8 * 60 * 60 * 1000, async () => {
      const resultado = await this.buscarCatalogo({
        medio: 'anime',
        estado: 'airing',
        orden: 'popularity:asc',
      });
      return resultado.items.slice(0, 10);
    });
  }

  async obtenerTopAnime(): Promise<PopularItem[]> {
    return this.obtenerConCache('top-anime', 8 * 60 * 60 * 1000, async () => {
      const resultado = await this.buscarCatalogo({
        medio: 'anime',
        orden: 'popularity:asc',
      });
      return resultado.items
        .filter(i => typeof i.score === 'number' && i.score >= 7)
        .slice(0, 5)
        .map(i => ({
          id: i.id,
          title: i.title,
          type: i.type,
          synopsis: i.synopsis,
          genres: i.genres,
          year: i.year,
          count: i.total,
          countLabel: 'episodio',
          img: i.img,
          medio: 'anime',
        }));
    });
  }

  async obtenerTopManga(): Promise<PopularItem[]> {
    return this.obtenerConCache('top-manga', 8 * 60 * 60 * 1000, async () => {
      const resultado = await this.buscarCatalogo({
        medio: 'manga',
        orden: 'popularity:asc',
      });
      return resultado.items
        .filter(i => typeof i.score === 'number' && i.score >= 7)
        .slice(0, 5)
        .map(i => ({
          id: i.id,
          title: i.title,
          type: i.type,
          synopsis: i.synopsis,
          genres: i.genres,
          year: i.year,
          count: i.total,
          countLabel: 'capítulo',
          img: i.img,
          medio: 'manga',
        }));
    });
  }

  async obtenerProximos(): Promise<CatalogoItem[]> {
    return this.obtenerConCache('proximos', 8 * 60 * 60 * 1000, async () => {
      const resultado = await this.buscarCatalogo({
        medio: 'anime',
        estado: 'upcoming',
        orden: 'popularity:asc',
      });
      return resultado.items.slice(0, 10);
    });
  }

  async obtenerNoticias(cantidad = 5): Promise<Noticia[]> {
    return this.obtenerConCache(`noticias:${cantidad}`, 2 * 60 * 60 * 1000, async () => {
      try {
        const json = await this.pedirTenrai<{ data: JikanNoticia[] }>(`/news?limit=${cantidad}`);
        return (json.data || []).map(n => ({
          id: n.mal_id,
          titulo: n.title,
          extracto: n.excerpt ?? '',
          img: n.images?.jpg?.image_url || '',
          fuente: n.author_username || 'ANILEZ',
          fecha: n.date || '',
          url: n.url || '',
        }));
      } catch {
        return [];
      }
    });
  }

  // ─── SEASONS (para BrowsePage) ───────────────────────────────────────────

  async buscarPorTemporada(
    anio: number,
    temporada: string,
    pagina = 1,
    sfw = true,
  ): Promise<CatalogoRespuesta> {
    const p = new URLSearchParams();
    p.set('page', String(pagina));
    p.set('limit', '20');
    p.set('sfw', sfw ? 'true' : 'false');

    const json = await this.pedirTenrai<{
      data: JikanEntrada[];
      pagination?: {
        current_page?: number;
        last_visible_page?: number;
        items?: { total?: number };
      };
    }>(`/seasons/${anio}/${temporada}?${p.toString()}`);

    return {
      items: (json.data || []).map(e => this.normalizarEntrada(e, 'anime')),
      paginaActual: json.pagination?.current_page ?? 1,
      ultimaPagina: Math.min(json.pagination?.last_visible_page ?? 1, 100),
      total: json.pagination?.items?.total ?? (json.data || []).length,
    };
  }

  // ─── BÚSQUEDA GLOBAL ────────────────────────────────────────────────────

  async buscarGlobal(q: string, sfw = true): Promise<{ anime: CatalogoItem[]; manga: CatalogoItem[] }> {
    const [animeResult, mangaResult] = await Promise.allSettled([
      this.buscarCatalogo({ medio: 'anime', q, pagina: 1, sfw }),
      this.buscarCatalogo({ medio: 'manga', q, pagina: 1, sfw }),
    ]);

    return {
      anime: animeResult.status === 'fulfilled' ? animeResult.value.items.slice(0, 5) : [],
      manga: mangaResult.status === 'fulfilled' ? mangaResult.value.items.slice(0, 5) : [],
    };
  }

  // ─── INFO BÁSICA (para EstadoPage) ──────────────────────────────────────

  async obtenerBasico(medio: 'anime' | 'manga', id: number): Promise<{ id: number; title: string; img: string; total: number | null }> {
    const json = await this.pedirTenrai<{ data: ApiAnime | ApiManga }>(`/${medio}/${id}`);
    const d = json.data;
    const img = d.images?.jpg?.large_image_url || d.images?.jpg?.image_url || '';
    const total = medio === 'anime'
      ? (d as ApiAnime).episodes ?? null
      : (d as ApiManga).chapters ?? null;
    return { id: d.mal_id, title: d.title, img, total };
  }
}
