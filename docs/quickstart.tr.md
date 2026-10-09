# Türkçe hızlı başlangıç

DocDiff Studio belge sürümlerini bilgisayarınızda karşılaştırır. [Yayımlanan v0.2.0 beta](https://github.com/Pastalikek65/docdiff-studio/releases/tag/v0.2.0), PDF, desteklenen DOCX, seçili taranmış sayfalarda yerel İngilizce OCR ve toplu karşılaştırma için doğrulanmış Windows/Linux x64 paketleri içerir. [Releases](https://github.com/Pastalikek65/docdiff-studio/releases) sayfasındaki en güncel doğrulanmış sürümü seçin; yayın kaydı beta/kararlı ayrımını ve tam paket kanıtını gösterir.

Windows'ta ZIP'i indirin, `SHA256SUMS.txt` ile doğrulayın, bütün dosyaları çıkarın ve `DocDiff Studio.exe` çalıştırın. Paket için Node.js gerekmez. Linux'ta grafik oturumu ve Electron sistem kütüphaneleri gerekir; yayın notlarındaki sandbox izinlerini ve gerekiyorsa uygulamaya özel AppArmor profilini kurun, uygulamayı normal kullanıcıyla açın. Paketler imzasızdır.

Node.js 24 ve npm kurulu bir Windows x64 veya grafik oturumlu Linux x64 ortamında:

```sh
npm ci
npx install-electron --no
npm run build
npm start
```

Arayüzde Pair 1 için `examples/corpus/word-number-before.pdf` ve `word-number-after.pdf` seçin. **Compare pair** ile karşılaştırın; değişiklik listesinden sayfaya gidin, metni ve görüntüleri inceleyin. **Save selected HTML** çıktısı tarayıcıda tek başına açılır. **Add pair** sırayla işlenen toplu karşılaştırmalar ekler; **Save batch JSON** başarılı, başarısız, iptal ve çalıştırılmadı durumlarını kaydeder. DOCX örnekleri `examples/v1/corpus/docx-change-*` dosyalarıdır; konumlar paragraf ve tablo satırıdır, fiziksel sayfa değildir. Yayımlanan v0.1.0 ön sürümünde bu kontroller **Compare PDFs**, **Save HTML** ve **Save JSON** adlarını taşır.

**Comparison options** içindeki yerel İngilizce OCR isteğe bağlıdır. Original/Revised PDF pages alanlarına 1'den başlayan sayfa numaralarını yazın; iki belge toplamında en fazla 20 sayfa seçilebilir. Yalnız seçilen ve metin katmanı boş olan sayfalar okunur. Motor ve model paket içindedir. Güven puanı doğruluk garantisi değildir; OCR metnini görüntüyle karşılaştırın. Eşleşen OCR metni bile **Review needed** sonucunu korur.

Taranmış sayfalarda metin alınamazsa **Review needed** sonucu gösterilir. Görsellerin aynı görünmesi metnin doğru okunduğu anlamına gelmez. Metin yok sayma seçenekleri görsel farkları saklamaz. İptal edilen veya sınırı aşan iş tamamlanmış sonuç üretmez.

Dosyalar sunucuya gönderilmez. HTML/JSON raporları belgenin metnini ve görüntülerini içerebilir; paylaşmadan önce inceleyin. Kaynak dosyalar karşılaştırmada değişmez. Hesap, abonelik veya ücretli API gerekmez.

Yayımlanan özellik betası iki platformda doğrulandı; kararlı sürüm kapısı ayrıca eski ön sürümden profil/rapor uyumluluğunu ve yeni sürümün tam paket testlerini gerektirir. [Destek sınırları](support.md), [rapor formatları](report-formats.md) ve [yol haritası](roadmap.md) kapsamı açıklar.
