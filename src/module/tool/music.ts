/**
 * music.ts — RecommendMusic tool
 * Gợi ý bài hát theo mood (sad/chill/hype/romantic/lofi)
 *
 * Chiến lược:
 * 1. Map mood → keyword search (ví dụ: "lofi chill vietnamese", "sad love songs vietnamese")
 * 2. Gọi iTunes Search API (miễn phí, không cần key) để lấy 3-5 bài
 * 3. Trả về: title + artist + preview URL + gợi ý câu bot có thể nói
 *
 * iTunes API: https://itunes.apple.com/search?term=...&media=music&limit=5&country=vn
 */
import { fetch as undiciFetch } from 'undici';

export type MusicMood = 'sad' | 'chill' | 'hype' | 'romantic' | 'lofi' | 'angry' | 'happy';

const MOOD_TO_QUERY: Record<MusicMood, string[]> = {
    sad:       ['sad vietnamese songs', 'nhạc buồn việt', 'emotional ballad vietnamese'],
    chill:     ['chill vietnamese songs', 'lofi chill vietnamese', 'acoustic chill vietnamese'],
    hype:      ['vietnamese rap hype', 'edm vietnam', 'nhạc trẻ sôi động'],
    romantic:  ['love songs vietnamese', 'nhạc tình cảm việt', 'romantic vietnamese acoustic'],
    lofi:      ['lofi vietnamese', 'lofi hip hop chill', 'lofi study beats'],
    angry:     ['rock vietnamese', 'phonk', 'hard trap'],
    happy:     ['happy vietnamese pop', 'v-pop summer', 'nhạc vui tươi'],
};

interface ITunesResult {
    trackName?: string;
    artistName?: string;
    previewUrl?: string;
    trackViewUrl?: string;
    artworkUrl100?: string;
    collectionName?: string;
}

export interface MusicTrack {
    title: string;
    artist: string;
    album?: string;
    previewUrl?: string;
    trackUrl?: string;
    artwork?: string;
}

export interface MusicRecommendation {
    mood: MusicMood;
    query: string;
    tracks: MusicTrack[];
    suggestionLine: string; // câu gợi ý sẵn để AI dùng
}

async function searchITunes(query: string, limit: number = 4): Promise<MusicTrack[]> {
    const url = new URL('https://itunes.apple.com/search');
    url.searchParams.set('term', query);
    url.searchParams.set('media', 'music');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('country', 'VN');

    const res = await undiciFetch(url.toString(), {
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
    });
    if (!res.ok) throw new Error(`iTunes search failed: ${res.status}`);
    const data: any = await res.json();
    const results: ITunesResult[] = Array.isArray(data?.results) ? data.results : [];

    return results
        .filter((r) => r.trackName && r.artistName)
        .map((r) => ({
            title: String(r.trackName),
            artist: String(r.artistName),
            album: r.collectionName,
            previewUrl: r.previewUrl ?? undefined,
            trackUrl: r.trackViewUrl ?? undefined,
            artwork: r.artworkUrl100 ?? undefined,
        }));
}

export async function recommendMusic(mood: MusicMood = 'chill', limit: number = 3): Promise<MusicRecommendation> {
    const queries = MOOD_TO_QUERY[mood] ?? MOOD_TO_QUERY.chill;
    let tracks: MusicTrack[] = [];
    let lastErr: any = null;
    for (const q of queries) {
        try {
            const t = await searchITunes(q, limit);
            if (t.length > 0) {
                tracks = t.slice(0, limit);
                break;
            }
        } catch (e) {
            lastErr = e;
        }
    }
    if (tracks.length === 0) {
        // Fallback: gợi ý tĩnh theo mood
        const fallback = FALLBACK_PLAYLIST[mood] ?? FALLBACK_PLAYLIST.chill;
        return {
            mood,
            query: queries[0],
            tracks: fallback.slice(0, limit).map(t => ({ title: t[0], artist: t[1] })),
            suggestionLine: `Mood ${mood} — gợi ý: ${fallback.slice(0, limit).map(t => `${t[0]} - ${t[1]}`).join('; ')}`,
        };
    }

    const titles = tracks.map((t) => `"${t.title}" - ${t.artist}`).join(', ');
    const moodLine: Record<MusicMood, string> = {
        sad: 'buồn một chút cho nhẹ lòng',
        chill: 'chill chill cho êm',
        hype: 'năng lượng lên nào',
        romantic: 'cho không khí ngọt ngào',
        lofi: 'lofi.study chill',
        angry: 'xả hơi chút',
        happy: 'vui vẻ lên nha',
    };

    return {
        mood,
        query: queries[0],
        tracks,
        suggestionLine: `Mood ${mood} (${moodLine[mood]}) — gợi ý ${titles}`,
    };
}

const FALLBACK_PLAYLIST: Record<MusicMood, [string, string][]> = {
    sad: [
        ['Lạc Trôi', 'Sơn Tùng M-TP'],
        ['Đánh Đổi', 'RICS'],
        ['Có Ai Thương Em Như Anh', 'Trúc Nhân'],
        ['Buồn Của Anh', 'K-ICM'],
    ],
    chill: [
        ['Đi Về Nhà', 'Đen Vâu'],
        ['Bạc Phận', 'K-ICM'],
        ['Lofi Sài Gòn', 'Various'],
        ['Trời Giấu Mặt Trời', 'Đen Vâu'],
    ],
    hype: [
        ['Hãy Trao Cho Anh', 'Sơn Tùng M-TP'],
        ['Muộn Rồi Mà Sao Còn', 'Sơn Tùng M-TP'],
        ['Điếu Bốc', 'Đen Vâu'],
        ['See Tình', 'Hoàng Thùy Linh'],
    ],
    romantic: [
        ['Nàng Thơ', 'Hoàng Dũng'],
        ['Đường Tôi Chở Em Về', 'Bùi Anh Tuấn'],
        ['Đom Đóm', 'Trúc Nhân'],
        ['Có Em', 'Chillies'],
    ],
    lofi: [
        ['Lofi Vietnamese', 'Various'],
        ['Chill Lofi Sài Gòn', 'Various'],
        ['Midnight Lofi', 'Various'],
        ['Study Beats', 'Various'],
    ],
    angry: [
        ['Rock Việt', 'Various'],
        ['Bụi Mờ', 'Ngọt'],
        ['Đào Hoa', 'Various'],
        ['Phonk Drift', 'Various'],
    ],
    happy: [
        ['See Tình', 'Hoàng Thùy Linh'],
        ['Đi Về Nhà', 'Đen Vâu'],
        ['Bên Trên Tầng Lầu', 'Tăng Duy Tân'],
        ['Có Em', 'Chillies'],
    ],
};
