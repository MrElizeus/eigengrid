<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class BridgeSecretMiddleware
{
    public function handle(Request $request, Closure $next): Response
    {
        $secret = config('app.bridge_secret');

        if (!$secret) {
            return response()->json([
                'status' => 'error',
                'message' => 'Bridge secret not configured',
            ], 500);
        }

        $providedSecret = $request->header('X-Bridge-Secret');

        if (!$providedSecret || $providedSecret !== $secret) {
            return response()->json([
                'status' => 'error',
                'message' => 'Invalid or missing bridge secret',
            ], 401);
        }

        return $next($request);
    }
}
