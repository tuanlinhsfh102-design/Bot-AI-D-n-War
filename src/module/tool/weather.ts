/**
 * weather.ts — GetWeather tool
 * Dùng Open-Meteo (miễn phí, không cần API key)
 * Geocode bằng Open-Meteo geocoding API
 *
 * Trả về mô tả thời tiết ngắn gọn bằng tiếng Việt, kèm gợi ý mood
 * (ví dụ: "trời mưa, mood chill hợp nghe lofi")
 */
import { fetch as undiciFetch } from 'undici';

interface GeoResult {
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    admin1?: string;
}

async function geocodeCity(city: string): Promise<GeoResult | null> {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', city);
    url.searchParams.set('count', '1');
    url.searchParams.set('language', 'vi');
    url.searchParams.set('format', 'json');

    const res = await undiciFetch(url.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);
    const data: any = await res.json();
    const hit = data?.results?.[0];
    if (!hit) return null;
    return {
        name: hit.name,
        latitude: hit.latitude,
        longitude: hit.longitude,
        country: hit.country,
        admin1: hit.admin1,
    };
}

const WMO_CODE_VI: Record<number, string> = {
    0: 'trời quang, nắng đẹp',
    1: 'trời khá quang, ít mây',
    2: 'trời có mây rải rác',
    3: 'trời nhiều mây, u ám',
    45: 'sương mù',
    48: 'sương mù đọng băng',
    51: 'mưa phùn nhẹ',
    53: 'mưa phùn vừa',
    55: 'mưa phùn dày',
    56: 'mưa phùn lạnh nhẹ',
    57: 'mưa phùn lạnh dày',
    61: 'mưa nhỏ',
    63: 'mưa vừa',
    65: 'mưa to',
    66: 'mưa lạnh nhẹ',
    67: 'mưa lạnh to',
    71: 'tuyết rơi nhẹ',
    73: 'tuyết rơi vừa',
    75: 'tuyết rơi dày',
    77: 'hạt tuyết',
    80: 'mưa rào nhỏ',
    81: 'mưa rào vừa',
    82: 'mưa rào to',
    85: 'tuyết rào nhỏ',
    86: 'tuyết rào to',
    95: 'dông, sét',
    96: 'dông có mưa đá nhẹ',
    99: 'dông có mưa đá to',
};

function weatherCodeToText(code: number): string {
    return WMO_CODE_VI[code] ?? `mã thời tiết ${code}`;
}

function moodHint(code: number, tempC: number): string {
    if ([45, 48].includes(code)) return 'sương mù — hơi trầm, hợp nghe lofi nhẹ';
    if ([51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82].includes(code)) return 'mưa — chill, hợp ôm cốc nóng và nhạc buồn';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return 'tuyết — lãng mạn, muốn đi dạo cùng ai đó';
    if ([95, 96, 99].includes(code)) return 'dông — ở nhà cho an toàn, hơi căng thẳng nhẹ';
    if (code === 0 && tempC >= 28) return 'nắng nóng — hơi lười, hợp cafe lạnh';
    if (code === 0 && tempC <= 22) return 'trời mát dễ chịu — năng lượng, hợp đi dạo';
    if (code === 0) return 'trời đẹp — vui vẻ, có thể rủ user đi chơi';
    return 'bình thường';
}

export interface WeatherResult {
    city: string;
    region?: string;
    country?: string;
    temperature: number;
    apparentTemperature: number;
    code: number;
    description: string;
    humidity: number;
    windSpeed: number;
    moodHint: string;
    isDay: boolean;
    summary: string; // chuỗi sẵn để AI dùng
}

export async function getWeather(city: string): Promise<WeatherResult> {
    const geo = await geocodeCity(city);
    if (!geo) throw new Error(`Không tìm thấy thành phố: ${city}`);

    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(geo.latitude));
    url.searchParams.set('longitude', String(geo.longitude));
    url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m');
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', '1');

    const res = await undiciFetch(url.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`Weather API failed: ${res.status}`);
    const data: any = await res.json();
    const cur = data?.current;
    if (!cur) throw new Error('Weather API returned no current data');

    const code = Number(cur.weather_code ?? 0);
    const tempC = Number(cur.temperature_2m ?? 0);
    const desc = weatherCodeToText(code);
    const mood = moodHint(code, tempC);

    const result: WeatherResult = {
        city: geo.name,
        region: geo.admin1,
        country: geo.country,
        temperature: tempC,
        apparentTemperature: Number(cur.apparent_temperature ?? tempC),
        code,
        description: desc,
        humidity: Number(cur.relative_humidity_2m ?? 0),
        windSpeed: Number(cur.wind_speed_10m ?? 0),
        moodHint: mood,
        isDay: Number(cur.is_day ?? 1) === 1,
        summary: `${geo.name}: ${desc}, ${tempC}°C (cảm giác ${cur.apparent_temperature ?? tempC}°C), độ ẩm ${cur.relative_humidity_2m ?? 0}%, gió ${cur.wind_speed_10m ?? 0} km/h. Mood: ${mood}`,
    };
    return result;
}

// Hàm tiện ích để bot tự đoán city mặc định (Hà Nội) nếu user chỉ nói "thời tiết"
export const DEFAULT_CITY = 'Hà Nội';

export async function getWeatherDefault(): Promise<WeatherResult> {
    return getWeather(DEFAULT_CITY);
}
