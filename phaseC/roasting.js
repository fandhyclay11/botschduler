// phaseC/roasting.js
// -------------------------------------------------------------
// Roasting + motivasi ringan untuk peringkat bawah leaderboard.
// - Playful, tidak menyerang tubuh/keluarga/agama/etnis/karakter.
// - Pesan bervariasi (rotasi random) agar tidak monoton.
// - Untuk Fase D, AI dapat menghasilkan variasi tambahan; di sini
//   kita pakai template lokal.
// -------------------------------------------------------------

const ROASTING = [
    (name) => `😏 ${name}, podium sudah kelihatan... tinggal panjat.`,
    (name) => `🥲 ${name}, semangat! Grafiknya lagi cari arah naik.`,
    (name) => `☕ ${name}, kopinya udah dingin. Waktunya beraksi.`,
    (name) => `📉 ${name}, peringkatmu perlu upgrade — masih ada waktu.`,
    (name) => `🚶 ${name}, jalan santai boleh, tapi jangan mampir tidur.`,
    (name) => `🧘 ${name}, meditasi udah cukup. Sekarang eksekusi.`,
    (name) => `🐢 ${name}, pelan boleh — asal jangan berhenti.`,
    (name) => `🔋 ${name}, baterai low. Isi ulang dan tancap gas.`
];

const MOTIVASI = [
    () => `💪 Setiap tugas yang diselesaikan dengan baik adalah langkah kecil menuju hasil yang lebih besar. Pertahankan disiplin, jangan menunggu sempurna untuk mulai bergerak, dan manfaatkan setiap kesempatan berikutnya untuk meningkatkan pencapaian.`,
    () => `🚀 Peringkat hari ini bukan akhir dari perjalanan. Tetap fokus pada tanggung jawab masing-masing, selesaikan tugas dengan konsisten, dan jadikan setiap evaluasi sebagai dorongan untuk tumbuh lebih baik dari hari sebelumnya.`,
    () => `🌱 Konsistensi kecil yang dilakukan setiap hari akan membentuk hasil yang besar. Jangan berkecil hati jika poinmu belum tinggi; yang penting terus berusaha, saling mendukung, dan membuktikan kemajuan melalui tindakan nyata.`,
    () => `🎯 Fokus pada proses, ketelitian, dan kualitas pekerjaan. Satu tugas yang selesai dengan penuh tanggung jawab lebih berarti daripada banyak rencana yang tidak dijalankan. Besok masih ada kesempatan untuk memperbaiki hasil dan naik ke peringkat berikutnya.`,
    () => `🔥 Satu reaction menandakan tugas telah diselesaikan, tetapi keberhasilan sebenarnya terlihat dari kedisiplinan, kerja sama, dan kualitas hasilnya. Tetap semangat, jaga komunikasi, dan terus berikan kontribusi terbaik untuk tim.`,
    () => `🏆 Persaingan di leaderboard sebaiknya menjadi motivasi yang sehat, bukan tekanan. Hargai pencapaian rekan kerja, belajar dari hasil hari ini, lalu kembali berusaha dengan sikap positif dan tanggung jawab yang lebih kuat.`,
    () => `🌟 Tidak ada kontribusi yang terlalu kecil ketika dilakukan dengan konsisten. Terus jaga standar kerja, bantu tim saat dibutuhkan, dan gunakan kesempatan berikutnya untuk menunjukkan perkembangan yang nyata.`
];

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

// entries = leaderboard sudah tersortir dari getLeaderboard()
// Ambil 1-2 peringkat bawah untuk di-roast, sisanya diberi motivasi umum.
export function buildRoasting(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const tail = entries.slice(-Math.min(2, entries.length));
    // Kalau leaderboard cuma 1 orang, biarkan motivasi saja
    const lines = [];
    if (entries.length >= 3) {
        for (const e of tail) {
            lines.push(pick(ROASTING)(e.name || e.id));
        }
    }
    lines.push(pick(MOTIVASI)());
    return lines.join('\n');
}
