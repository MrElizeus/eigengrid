<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class DashboardController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $user = $request->user();

        // Simulated operational metrics — extend with real models as the app grows
        $stats = [
            [
                'label' => 'Active Nodes',
                'value' => random_int(120, 250),
                'change' => '+4.5%',
                'trend' => 'up',
            ],
            [
                'label' => 'Grid Load',
                'value' => random_int(60, 95) . '%',
                'change' => '-1.2%',
                'trend' => 'down',
            ],
            [
                'label' => 'Uptime (30d)',
                'value' => '99.97%',
                'change' => '+0.02%',
                'trend' => 'up',
            ],
            [
                'label' => 'Pending Tasks',
                'value' => random_int(5, 80),
                'change' => '-12',
                'trend' => 'down',
            ],
        ];

        $recentActivity = [
            [
                'id' => 1,
                'action' => 'Node scaled',
                'target' => 'us-east-07',
                'time' => '2 min ago',
                'status' => 'success',
            ],
            [
                'id' => 2,
                'action' => 'Health check passed',
                'target' => 'eu-west-03',
                'time' => '8 min ago',
                'status' => 'success',
            ],
            [
                'id' => 3,
                'action' => 'Rate limit triggered',
                'target' => 'ap-south-01',
                'time' => '14 min ago',
                'status' => 'warning',
            ],
            [
                'id' => 4,
                'action' => 'Deployment rolled back',
                'target' => 'us-west-12',
                'time' => '23 min ago',
                'status' => 'error',
            ],
            [
                'id' => 5,
                'action' => 'New node provisioned',
                'target' => 'eu-central-02',
                'time' => '31 min ago',
                'status' => 'success',
            ],
        ];

        $gridStatus = [
            ['name' => 'us-east', 'nodes' => 42, 'healthy' => 40, 'region' => 'North America'],
            ['name' => 'us-west', 'nodes' => 38, 'healthy' => 37, 'region' => 'North America'],
            ['name' => 'eu-west', 'nodes' => 31, 'healthy' => 31, 'region' => 'Europe'],
            ['name' => 'eu-central', 'nodes' => 24, 'healthy' => 22, 'region' => 'Europe'],
            ['name' => 'ap-south', 'nodes' => 18, 'healthy' => 15, 'region' => 'Asia Pacific'],
            ['name' => 'ap-northeast', 'nodes' => 14, 'healthy' => 14, 'region' => 'Asia Pacific'],
        ];

        return response()->json([
            'user' => ['name' => $user->name, 'email' => $user->email],
            'stats' => $stats,
            'recentActivity' => $recentActivity,
            'gridStatus' => $gridStatus,
        ]);
    }
}
