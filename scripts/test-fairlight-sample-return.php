<?php
define('ABSPATH', '/');
function add_action(...$args) {}
function wp_strip_all_tags($s) {return strip_tags($s);}
function wp_json_encode($v) {return json_encode($v);}
if (isset($argv[1])) {
    // Code Snippets exports the PHP body without a PHP opening tag.
    eval(file_get_contents($argv[1]));
} else {
    require '/patched.php';
}

function check($valid, $message) {
    if (!$valid) throw new Exception($message);
}
$base = ['Product'=>['Indoor Blinds'], 'Type of Indoor Blinds'=>['Everyday Roller Blinds']];
$singles = [
    ['Blockout', 'Blockout Fabric Options - Everyday roller blinds', 'Fairlight Blockout', 'fa2b0c071001a', 'fsbo'],
    ['Light Filter', 'Light Filter Fabric Options - Everyday roller blinds', 'Fairlight Light Filter', 'fa2f1c071001b', 'fslf'],
    ['Sunscreen', 'Sunscreen Fabric Options - Everyday Roller blinds', 'Fairlight Sheer', 'fa25c071001c', 'fssh'],
];
foreach ($singles as [$type,$field,$range,$id,$prefix]) {
    $meta = $base + [
        'Roller Blind Configurations'=>['Single'],
        'Fabric Combinations - Single Blinds'=>[$type],
        $field=>[$range],
        $range.' Colours'=>['Whisper, Oat, Mocha, Latte, Coconut, Cashew, Ash'],
    ];
    $result = BM_Sample_Return_Live_V2::line($meta);
    check(count($result['links']) === 7 && !$result['warnings'], $range.' single: '.json_encode($result));
    foreach ($result['links'] as $index => $link) {
        check(str_contains(urldecode($link['url']), '3839:'.$id.':'.$prefix.($index + 1)), 'Wrong colour key');
    }
}
$dual = $base + [
    'Roller Blind Configurations'=>['Dual'],
    'Fabric Combinations - Dual Blinds'=>['Blockout & Sunscreen'],
    'Blockout Fabric Options - Everyday roller blinds'=>['Fairlight Blockout'],
    'Fairlight Blockout Colours'=>['Whisper'],
    'Sunscreen Fabric Options - Everyday Roller blinds'=>['Duo Screen'],
    'Duo Screen Colours - Everyday'=>['White, Ice White, White Grey'],
];
$result = BM_Sample_Return_Live_V2::line($dual);
check(count($result['links']) === 7 && !$result['warnings'], 'Mixed dual: '.json_encode($result));
check(count(array_filter($result['links'], fn($link) => str_contains($link['url'],'bm_sample_mode=dual'))) === 3, 'Missing dual pairs');

$large = $base + [
    'Roller Blind Configurations'=>['Dual'],
    'Fabric Combinations - Dual Blinds'=>['Blockout & Light Filter'],
    'Blockout Fabric Options - Everyday roller blinds'=>['Duo Block'],
    'Duo Blockout Colours'=>['Aztec, Basalt, Cumulus, Dove, Muse, Nova, Salt'],
    'Light Filter Fabric Options - Everyday roller blinds'=>['Fairlight Light Filter'],
    'Fairlight Light Filter Colours'=>['Whisper, Oat, Mocha, Latte, Coconut, Cashew, Ash'],
];
$result = BM_Sample_Return_Live_V2::line($large);
check(count($result['links']) === 14 && $result['warnings'] === ['too_many_dual_pairs'], 'Dual cap: '.json_encode($result));
$totalblock = $base;
$totalblock['Type of Indoor Blinds'] = ['TotalBlock Cassette Blind'];
$totalblock['Fairlight Blockout Colours'] = ['Whisper'];
check(BM_Sample_Return_Live_V2::line($totalblock)['links'] === [], 'TotalBlock routed as Everyday');

echo "PASS PHP: 21 Fairlight colours, three mixed dual pairs, 49-pair limit, and TotalBlock isolation\n";
