"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-sm text-center">
        <p className="text-4xl">⚠️</p>
        <h2 className="mt-3 text-lg font-bold text-[#241012]">Something went wrong</h2>
        <p className="mt-2 text-sm text-[#6B5458]">{error.message}</p>
        <button
          onClick={reset}
          className="mt-5 rounded-lg bg-[#7B1113] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#5c0d0e]"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
