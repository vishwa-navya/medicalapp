import { useEffect, useState } from 'react';
import { X, Download } from 'lucide-react';
import { downloadFile } from '../lib/supabase';

interface PdfViewerModalProps {
  fileUrl: string;
  fileName: string;
  isOpen: boolean;
  onClose: () => void;
}

function PdfViewerModal({ fileUrl, fileName, isOpen, onClose }: PdfViewerModalProps) {
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setViewerUrl(null);
      setLoadError(false);
      return;
    }

    let objectUrl: string | null = null;
    let cancelled = false;

    const loadPdf = async () => {
      try {
        setLoadError(false);
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error('PDF could not be loaded');

        const blob = await response.blob();
        objectUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        if (!cancelled) setViewerUrl(objectUrl);
      } catch (error) {
        console.error('PDF preview failed:', error);
        if (!cancelled) setLoadError(true);
      }
    };

    void loadPdf();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileUrl, isOpen]);

  if (!isOpen) return null;

  const handleDownload = async () => {
    try {
      await downloadFile(fileUrl, fileName);
    } catch (error) {
      console.error('PDF download failed:', error);
      alert('Failed to download PDF. Please try again.');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/90 flex flex-col z-[60]">
      <div className="flex items-center justify-between px-4 py-3 bg-black/40 backdrop-blur-md">
        <h3 className="text-white font-medium truncate flex-1 mr-4">{fileName}</h3>
        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 bg-green-500 text-white px-3 py-1.5 rounded-lg hover:bg-green-600 transition-colors text-sm mr-2"
          title="Download"
        >
          <Download className="w-4 h-4" />
          <span className="hidden sm:inline">Download</span>
        </button>
        <button
          onClick={onClose}
          className="bg-white/20 text-white p-2 rounded-lg hover:bg-white/30 transition-colors"
          title="Close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 w-full flex items-center justify-center relative">
        {viewerUrl ? (
          <iframe src={viewerUrl} className="w-full h-full border-0" title={fileName} />
        ) : loadError ? (
          <div className="text-center text-white px-6">
            <p className="mb-4">This PDF could not be previewed here.</p>
            <button
              onClick={handleDownload}
              className="bg-green-500 text-white px-4 py-2 rounded-lg hover:bg-green-600 transition-colors"
            >
              Download PDF
            </button>
          </div>
        ) : (
          <div className="text-white">Loading PDF...</div>
        )}
      </div>

      {/* Floating red cancel button — right-center edge */}
      <button
        onClick={onClose}
        className="fixed top-1/2 right-4 -translate-y-1/2 z-[70] bg-red-600 text-white w-14 h-14 rounded-full flex items-center justify-center shadow-lg hover:bg-red-700 active:scale-95 transition-all"
        title="Close PDF"
        aria-label="Close PDF"
      >
        <X className="w-7 h-7" />
      </button>
    </div>
  );
}

export default PdfViewerModal;
