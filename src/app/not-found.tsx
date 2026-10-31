import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-sm text-center">
        <p className="text-6xl font-bold text-[#7B1113]">404</p>
        <h2 className="mt-3 text-lg font-bold text-[#241012]">Page Not Found</h2>
        <p className="mt-2 text-sm text-[#6B5458]">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          href="/"
          className="mt-5 inline-block rounded-lg bg-[#7B1113] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#5c0d0e]"
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
}
