// FlyConsole libretro frontend. SPDX-License-Identifier: GPL-2.0-or-later
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>
#include "libretro.h"

static std::unordered_map<std::string, std::string> options;
static retro_system_av_info av;
static std::vector<uint32_t> pixels(512 * 512);
static std::vector<uint8_t> state;
static float audio_left[8192], audio_right[8192];
static unsigned width, height, audio_count, format = RETRO_PIXEL_FORMAT_0RGB1555;
static unsigned masks[2];
static bool loaded, invalid;

static void definitions(const retro_core_option_definition *defs) {
    if (!defs) return;
    for (; defs->key; ++defs)
        if (defs->default_value) options[defs->key] = defs->default_value;
}
#ifdef RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2
static void definitions_v2(const retro_core_option_v2_definition *defs) {
    if (!defs) return;
    for (; defs->key; ++defs)
        if (defs->default_value) options[defs->key] = defs->default_value;
}
#endif
static bool environment(unsigned command, void *data) {
    switch (command) {
    case RETRO_ENVIRONMENT_GET_CAN_DUPE: *static_cast<bool *>(data) = true; return true;
    case RETRO_ENVIRONMENT_GET_OVERSCAN: *static_cast<bool *>(data) = false; return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
        format = *static_cast<unsigned *>(data);
        return format <= RETRO_PIXEL_FORMAT_RGB565;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        *static_cast<const char **>(data) = "/"; return true;
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
#ifdef RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2
        *static_cast<unsigned *>(data) = 2;
#else
        *static_cast<unsigned *>(data) = 1;
#endif
        return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS: definitions(static_cast<retro_core_option_definition *>(data)); return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL: definitions(static_cast<retro_core_options_intl *>(data)->us); return true;
#ifdef RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2: definitions_v2(static_cast<retro_core_options_v2 *>(data)->definitions); return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL: definitions_v2(static_cast<retro_core_options_v2_intl *>(data)->us->definitions); return true;
#endif
    case RETRO_ENVIRONMENT_SET_VARIABLES:
        for (auto *v = static_cast<retro_variable *>(data); v && v->key; ++v) {
            std::string value(v->value ? v->value : "");
            auto at = value.find(';');
            if (at != std::string::npos) {
                value = value.substr(at + 1);
                value.erase(0, value.find_first_not_of(' '));
                options[v->key] = value.substr(0, value.find('|'));
            }
        }
        return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
        auto *v = static_cast<retro_variable *>(data);
        auto found = options.find(v->key);
        v->value = found == options.end() ? nullptr : found->second.c_str();
        return v->value != nullptr;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: *static_cast<bool *>(data) = false; return true;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS: return true;
    case RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE: *static_cast<int *>(data) = 3; return true;
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: av = *static_cast<retro_system_av_info *>(data); return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY: av.geometry = *static_cast<retro_game_geometry *>(data); return true;
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
#ifdef RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK:
#endif
        return true;
    default: return false;
    }
}
static void video(const void *data, unsigned w, unsigned h, size_t pitch) {
    if (!data) return; // Libretro duplicate frame retains the last raster.
    unsigned stride = format == RETRO_PIXEL_FORMAT_XRGB8888 ? 4 : 2;
    if (w == 0 || h == 0 || w > 512 || h > 512 || pitch < w * stride) { invalid = true; return; }
    width = w; height = h;
    for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) {
        const uint8_t *at = static_cast<const uint8_t *>(data) + y * pitch + x * stride;
        uint32_t color; unsigned r, g, b;
        if (stride == 4) {
            std::memcpy(&color, at, 4); r = (color >> 16) & 255; g = (color >> 8) & 255; b = color & 255;
        } else {
            uint16_t c; std::memcpy(&c, at, 2);
            if (format == RETRO_PIXEL_FORMAT_RGB565) { r = (c >> 11) & 31; g = (c >> 5) & 63; b = c & 31; g = (g << 2) | (g >> 4); }
            else { r = (c >> 10) & 31; g = (c >> 5) & 31; b = c & 31; g = (g << 3) | (g >> 2); }
            r = (r << 3) | (r >> 2); b = (b << 3) | (b >> 2);
        }
        pixels[y * w + x] = r | (g << 8) | (b << 16) | 0xff000000u;
    }
}
static void audio(int16_t left, int16_t right) {
    if (audio_count >= 8192) { invalid = true; return; }
    audio_left[audio_count] = left / 32768.0f;
    audio_right[audio_count++] = right / 32768.0f;
}
static size_t audio_batch(const int16_t *data, size_t frames) {
    for (size_t i = 0; i < frames; ++i) audio(data[2 * i], data[2 * i + 1]);
    return frames;
}
static void input_poll() {}
static int16_t input(unsigned port, unsigned device, unsigned, unsigned id) {
    if (port >= 2 || (device & RETRO_DEVICE_MASK) != RETRO_DEVICE_JOYPAD) return 0;
#ifdef FLY_GB
    if (port != 0) return 0;
    const unsigned map[] = {8, 0, 2, 3, 4, 5, 6, 7};
#else
    const unsigned map[] = {8, 0, 1, 3, 4, 5, 6, 7, 9, 10, 11, 2};
#endif
    unsigned result = 0;
    for (unsigned i = 0; i < sizeof(map) / sizeof(map[0]); ++i)
        if (masks[port] & (1u << i)) result |= 1u << map[i];
    return id == RETRO_DEVICE_ID_JOYPAD_MASK ? result : id < 16 && (result & (1u << id)) ? 1 : 0;
}
extern "C" {
void lab_init() {
    retro_set_environment(environment); retro_set_video_refresh(video);
    retro_set_audio_sample(audio); retro_set_audio_sample_batch(audio_batch);
    retro_set_input_poll(input_poll); retro_set_input_state(input); retro_init();
}
int lab_load_rom(const uint8_t *data, unsigned size) {
    if (loaded) retro_unload_game(); loaded = false; invalid = false;
    width = height = audio_count = masks[0] = masks[1] = 0;
    state.clear(); std::fill(pixels.begin(), pixels.end(), 0xff000000u);
    retro_game_info game = {"cartridge", data, size, nullptr};
    if (!retro_load_game(&game)) return 0;
    loaded = true; retro_get_system_av_info(&av);
    retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
#ifndef FLY_GB
    retro_set_controller_port_device(1, RETRO_DEVICE_JOYPAD);
#endif
    return 1;
}
void lab_tick(unsigned p1, unsigned p2) { masks[0] = p1; masks[1] = p2; audio_count = 0; if (loaded) retro_run(); }
void lab_reset() { masks[0] = masks[1] = audio_count = 0; invalid = false; if (loaded) retro_reset(); }
uint32_t *lab_video() { return pixels.data(); }
unsigned lab_width() { return width; }
unsigned lab_height() { return height; }
int lab_valid() { return loaded && !invalid; }
double lab_fps() { return av.timing.fps; }
double lab_sample_rate() { return av.timing.sample_rate; }
unsigned lab_audio_count() { return audio_count; }
float *lab_audio_left() { return audio_left; }
float *lab_audio_right() { return audio_right; }
unsigned lab_ram_size() { return loaded ? retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM) : 0; }
unsigned lab_read_ram(unsigned address) {
    auto *data = static_cast<uint8_t *>(retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM));
    return loaded && data && address < lab_ram_size() ? data[address] : 0;
}
unsigned lab_save_state() {
    size_t size = loaded ? retro_serialize_size() : 0;
    if (!size || size > 8 * 1024 * 1024) return 0;
    state.resize(size); return retro_serialize(state.data(), size) ? size : 0;
}
uint8_t *lab_state() { return state.data(); }
int lab_load_state(unsigned size) { return loaded && size == state.size() && retro_unserialize(state.data(), size); }
}
