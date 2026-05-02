<?php

namespace App\Http\Controllers;

use App\Services\SshSessionService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SshSessionController extends Controller
{
    public function __construct(private SshSessionService $sshSessionService) {}

    public function create(Request $request): JsonResponse
    {
        try {
            $request->validate([
                'machine_id' => ['required', 'string'],
            ]);

            $machineId = $request->input('machine_id');
            $this->validateMachineExists($machineId);

            $session = $this->sshSessionService->createSession($machineId, $request->user()->id);

            return response()->json([
                'status' => 'success',
                'token' => $session['token'],
                'ws_url' => $session['ws_url'],
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'status' => 'error',
                'message' => $e->getMessage(),
            ], 422);
        }
    }

    public function consume(string $token): JsonResponse
    {
        try {
            $this->validateTokenFormat($token);

            $session = $this->sshSessionService->getAndConsume($token);

            if (!$session) {
                return response()->json([
                    'status' => 'error',
                    'message' => 'Session token not found or expired',
                ], 404);
            }

            return response()->json($session);
        } catch (\Exception $e) {
            return response()->json([
                'status' => 'error',
                'message' => $e->getMessage(),
            ], 422);
        }
    }

    private function validateMachineExists(string $machineId): void
    {
        if (!config("wol.machines.{$machineId}")) {
            throw new \Exception("Machine '{$machineId}' not found");
        }
    }

    private function validateTokenFormat(string $token): void
    {
        if (!preg_match('/^[a-zA-Z0-9]{40}$/', $token)) {
            throw new \Exception("Invalid token format");
        }
    }
}
