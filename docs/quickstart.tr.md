# Türkçe hızlı başlangıç

DocDiff Studio iki belge sürümünü bilgisayarınızda karşılaştırır. İlk MVP dijital PDF'lerdeki metin ve görsel farkları gösterir; DOCX ve yerel OCR henüz bu aşamanın parçası değildir.

Node.js 24 ve npm kurulu bir Windows x64 veya grafik oturumlu Linux x64 ortamında:

```sh
npm ci
npx install-electron --no
npm run build
npm start
```

Before alanında `examples/corpus/word-number-before.pdf`, After alanında `word-number-after.pdf` seçin. **Compare PDFs** ile karşılaştırın; değişiklik listesinden sayfaya gidin, metni ve sayfa görüntülerini inceleyin. **Save HTML** çıktısı tarayıcıda tek başına açılır; **Save JSON** sürümlenmiş veri çıktısını kaydeder.

Taranmış sayfalarda metin alınamazsa **Review needed** sonucu gösterilir. Görsellerin aynı görünmesi metnin doğru okunduğu anlamına gelmez. Metin yok sayma seçenekleri görsel farkları saklamaz. İptal edilen veya sınırı aşan iş tamamlanmış sonuç üretmez.

Dosyalar sunucuya gönderilmez. HTML/JSON raporları belgenin metnini ve görüntülerini içerebilir; paylaşmadan önce inceleyin. Kaynak dosyalar karşılaştırmada değişmez. Hesap, abonelik veya ücretli API gerekmez.

Bu aşama bir MVP adayıdır; kararlı sürüm ve paket/platform doğrulaması henüz ilan edilmiyor. [Destek sınırları](support.md) ve [yol haritası](roadmap.md) kapsamı açıklar.
