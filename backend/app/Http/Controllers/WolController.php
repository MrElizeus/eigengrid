<?php

namespace App\Http\Controllers;

use App\Services\WakeOnLanService;
use Illuminate\Http\JsonResponse;

class WolController extends Controller
{
    public function __construct(private WakeOnLanService $wolService) {}

    public function wake(string $machineId): JsonResponse
    {
        try {
            $this->validateMachineExists($machineId);
            $this->wolService->wake($machineId);

            return response()->json([
                'status' => 'success',
                'message' => "Magic packet sent to {$machineId}",
                'machine_id' => $machineId,
            ]);
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
}
