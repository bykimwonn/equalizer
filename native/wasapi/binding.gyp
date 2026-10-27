{
  "targets": [
    {
      "target_name": "bt_wasapi",
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": [
              "wasapi_module.cc",
              "wasapi_engine.cc"
            ],
            "include_dirs": [
              "<!@(node -p \"require('node-addon-api').include\")"
            ],
            "libraries": [
              "-lole32.lib",
              "-lmmdevapi.lib",
              "-lavrt.lib",
              "-lwinmm.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/std:c++17", "/EHsc"],
                "ExceptionHandling": 1
              }
            },
            "defines": [
              "NOMINMAX",
              "WIN32_LEAN_AND_MEAN",
              "UNICODE",
              "_UNICODE"
            ]
          },
          {
            "sources": ["stub_unsupported.cc"],
            "include_dirs": [
              "<!@(node -p \"require('node-addon-api').include\")"
            ]
          }
        ]
      ]
    }
  ]
}
