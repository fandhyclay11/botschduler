// Helper murni untuk paginasi daftar jadwal.
//
// Mengatur ukuran halaman, batasan navigasi, dan pembangunan footer
// pagination. Nomor yang ditampilkan ke pengguna adalah nomor GLOBAL
// (1..total) agar perintah `edit N` dan `hapus N` tetap merujuk ke
// jadwal yang sama lintas halaman — pengguna tidak perlu mengingat
// berada di halaman berapa saat memilih.

export const SCHEDULE_PAGE_SIZE = 20;

export function getTotalPages(totalItems, pageSize = SCHEDULE_PAGE_SIZE) {
    if (!Number.isFinite(totalItems) || totalItems <= 0) return 1;
    if (!Number.isFinite(pageSize) || pageSize <= 0) return 1;
    return Math.max(1, Math.ceil(totalItems / pageSize));
}

export function clampPage(page, totalItems, pageSize = SCHEDULE_PAGE_SIZE) {
    const totalPages = getTotalPages(totalItems, pageSize);
    const n = Number(page);
    if (!Number.isFinite(n) || n < 1) return 1;
    if (n > totalPages) return totalPages;
    return Math.trunc(n);
}

export function getPageSlice(items, page, pageSize = SCHEDULE_PAGE_SIZE) {
    const safe = Array.isArray(items) ? items : [];
    const totalPages = getTotalPages(safe.length, pageSize);
    const current = clampPage(page, safe.length, pageSize);
    const startIndex = (current - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, safe.length);
    return {
        page: current,
        totalPages,
        totalItems: safe.length,
        startIndex,
        endIndex,
        items: safe.slice(startIndex, endIndex)
    };
}

// Footer pagination.
// listCommand = perintah dasar untuk menampilkan daftar, mis. "jadwal",
// "jadwal semua", "@bot jadwal". Digunakan untuk memberitahu pengguna
// cara menuju halaman berikutnya/sebelumnya tanpa menebak sintaks.
// itemLabel = kata benda untuk item yang di-paginasi (default "jadwal"
// untuk kompatibilitas dengan pemakai awal).
export function buildPaginationFooter(slice, listCommand = 'jadwal', itemLabel = 'jadwal') {
    if (!slice || slice.totalItems <= 0) return '';
    if (slice.totalPages <= 1) return '';

    const lines = [];
    lines.push(`Halaman ${slice.page}/${slice.totalPages} — total ${slice.totalItems} ${itemLabel}.`);

    const nav = [];
    if (slice.page > 1) {
        nav.push(`*${listCommand} ${slice.page - 1}* untuk halaman sebelumnya`);
    }
    if (slice.page < slice.totalPages) {
        nav.push(`*${listCommand} ${slice.page + 1}* untuk halaman berikutnya`);
    }
    if (nav.length > 0) {
        lines.push(nav.join(' • '));
    }
    return lines.join('\n');
}

// Parse argumen opsional "<page>" dari command list.
// Mengembalikan integer >=1 atau null kalau argumen bukan nomor halaman.
export function parsePageArgument(rawArg) {
    const trimmed = String(rawArg || '').trim();
    if (trimmed === '') return 1;
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    return n;
}
