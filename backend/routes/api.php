<?php

use App\Http\Controllers\DashboardController;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Route;
use Illuminate\Validation\ValidationException;

Route::post('/login', function (Request $request) {
        $request->validate([
            'email' => ['required', 'string', 'email'],
            'password' => ['required', 'string'],
        ]);

        $user = User::where('email', $request->email)->first();

        if (! $user || ! Hash::check($request->password, $user->password)) {
            throw ValidationException::withMessages([
                'email' => ['The provided credentials are not correct.'],
            ]);
        }

        $token = $user->createToken('eigengrid')->plainTextToken;

        return response()->json(['message' => 'Logged in', 'token' => $token]);
    });

Route::post('/register', function (Request $request) {
        $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'string', 'email', 'max:255', 'unique:users'],
            'password' => ['required', 'string', 'min:8', 'confirmed'],
        ]);

        $user = User::create([
            'name' => $request->name,
            'email' => $request->email,
            'password' => Hash::make($request->password),
        ]);

        $token = $user->createToken('eigengrid')->plainTextToken;

        return response()->json([
            'message' => 'Registered',
            'user' => $user,
            'token' => $token,
        ]);
    });

Route::middleware(['auth:sanctum'])->group(function () {
    Route::post('/logout', function (Request $request) {
        $request->user()->currentAccessToken()?->delete();

        return response()->json(['message' => 'Logged out']);
    });

    Route::get('/user', function (Request $request) {
        return response()->json($request->user());
    });

    Route::get('/dashboard', [DashboardController::class, 'index']);
});
