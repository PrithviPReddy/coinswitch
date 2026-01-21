export function Loading(){
    return (
    <div className="flex min-h-[60vh] w-full items-center justify-center">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        
        {/* Avatar + name */}
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 animate-pulse rounded-full bg-slate-200" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-1/2 animate-pulse rounded bg-slate-200" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-slate-100" />
          </div>
        </div>

        {/* Divider */}
        <div className="my-6 h-px w-full bg-slate-100" />

        {/* Tabs */}
        <div className="flex gap-4">
          <div className="h-8 w-20 animate-pulse rounded-lg bg-slate-200" />
          <div className="h-8 w-20 animate-pulse rounded-lg bg-slate-100" />
          <div className="h-8 w-20 animate-pulse rounded-lg bg-slate-100" />
        </div>

        {/* Content */}
        <div className="mt-6 space-y-3">
          <div className="h-4 w-full animate-pulse rounded bg-slate-200" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-slate-100" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
        </div>
      </div>
    </div>
  );
}


export function Warning() {
  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        
        <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
          <svg
            className="h-6 w-6 text-amber-600"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86l-8.02 14A2 2 0 004.01 21h15.98a2 2 0 001.72-3.14l-8.02-14a2 2 0 00-3.4 0z" />
          </svg>
        </div>

        <h2 className="mb-2 text-lg font-semibold text-slate-900">
          Feature not available
        </h2>

        <p className="text-sm text-slate-600">
          This section is part of an upcoming release. The functionality is currently
          disabled to ensure stability and data integrity.
        </p>

      </div>
    </div>
  );
}

