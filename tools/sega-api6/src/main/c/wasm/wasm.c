#include <emscripten/emscripten.h>
#include "shared.h"
#include "fileio.h"
#include "md_ntsc.h"
#include "sms_ntsc.h"

#define SOUND_FREQUENCY 44100
#define SOUND_SAMPLES_SIZE 2048

#define VIDEO_WIDTH  640
#define VIDEO_HEIGHT 480

#define GAMEPAD_API_INDEX 64

uint32_t *frame_buffer;
static uint32_t *frame_allocation;
int16_t *sound_frame;
static int selected_region = 0;
static int started = 0;
float_t *input_buffer;

uint8_t *lab_state;
float_t *web_audio_l;
float_t *web_audio_r;

void EMSCRIPTEN_KEEPALIVE init(void)
{
    lab_state = malloc(STATE_SIZE);
    // vram & sampling malloc
    rom_buffer = malloc(sizeof(uint8_t) * MAXROMSIZE);
    frame_allocation = calloc(VIDEO_WIDTH * VIDEO_HEIGHT + 8, sizeof(uint32_t));
    frame_buffer = frame_allocation + 4;
    for (int i = 0; i < 4; i++) { frame_allocation[i] = 0x5ac39e71u; frame_buffer[VIDEO_WIDTH * VIDEO_HEIGHT + i] = 0x5ac39e71u; }
    sound_frame = malloc(sizeof(int16_t) * SOUND_SAMPLES_SIZE * 2);
    web_audio_l = malloc(sizeof(float_t) * SOUND_SAMPLES_SIZE);
    web_audio_r = malloc(sizeof(float_t) * SOUND_SAMPLES_SIZE);
    input_buffer = calloc(GAMEPAD_API_INDEX, sizeof(float_t));
}

int EMSCRIPTEN_KEEPALIVE start(void)
{
    if (started) audio_shutdown();
    // system init
    error_init();
    set_config_defaults();
    config.region_detect = selected_region;

    // video ram init
    memset(&bitmap, 0, sizeof(bitmap));
    bitmap.width      = VIDEO_WIDTH;
    bitmap.height     = VIDEO_HEIGHT;
    bitmap.pitch      = VIDEO_WIDTH * 4;
    bitmap.data       = (uint8_t *)frame_buffer;
    bitmap.viewport.changed = 3;

    // load rom
    if (!load_rom("dummy.bin") || system_hw != SYSTEM_MD) return 0;

    // emurator init
    audio_init(SOUND_FREQUENCY, 0);
    system_init();
    system_reset();
    started = 1;
    return 1;
}

float_t convert_sample_i2f(int16_t i) {
    float_t f;
    if(i < 0) {
        f = ((float) i) / (float) 32768;
    } else {
        f = ((float) i) / (float) 32767;
    }
    if( f > 1 ) f = 1;
    if( f < -1 ) f = -1;
    return f;
}

void EMSCRIPTEN_KEEPALIVE tick(void) {
    system_frame_gen(0);
}

int EMSCRIPTEN_KEEPALIVE sound(void) {
    int size = audio_update(sound_frame);
    if (size < 0 || size > SOUND_SAMPLES_SIZE) return -1;
    int p = 0;
    for(int i = 0; i < size * 2; i += 2) {
        web_audio_l[p] = convert_sample_i2f(sound_frame[i]);
        web_audio_r[p] = convert_sample_i2f(sound_frame[i + 1]);
        p++;
    }
    return p;
}

int EMSCRIPTEN_KEEPALIVE lab_core_api(void) { return 6; }
int EMSCRIPTEN_KEEPALIVE wasm_input_update(void) {
    for(int player=0;player<2;player++) {
        int port=player*4; /* Genesis Plus GX: physical port B is pad[4]. */
        float_t *b=input_buffer+player*32;
        input.pad[port]=0;
        if(b[10]) input.pad[port]|=INPUT_A;
        if(b[11]) input.pad[port]|=INPUT_B;
        if(b[9]) input.pad[port]|=INPUT_C;
        if(b[15]) input.pad[port]|=INPUT_START;
        if(b[8]) input.pad[port]|=INPUT_X;
        if(b[12]) input.pad[port]|=INPUT_Y;
        if(b[13]) input.pad[port]|=INPUT_Z;
        if(b[14]) input.pad[port]|=INPUT_MODE;
        if(b[7]==-1) input.pad[port]|=INPUT_UP;
        else if(b[7]==1) input.pad[port]|=INPUT_DOWN;
        if(b[6]==-1) input.pad[port]|=INPUT_LEFT;
        else if(b[6]==1) input.pad[port]|=INPUT_RIGHT;
    }
    return 1;
}

uint8_t* EMSCRIPTEN_KEEPALIVE get_rom_buffer_ref(uint32_t size) {
    if (size < 514 || size > MAXROMSIZE || !rom_buffer) return 0;
    rom_size = size;
    return rom_buffer;
}

uint32_t* EMSCRIPTEN_KEEPALIVE get_frame_buffer_ref(void) {
    return frame_buffer;
}

float_t* EMSCRIPTEN_KEEPALIVE get_web_audio_l_ref(void) {
    return web_audio_l;
}

float_t* EMSCRIPTEN_KEEPALIVE get_web_audio_r_ref(void) {
    return web_audio_r;
}

float_t* EMSCRIPTEN_KEEPALIVE get_input_buffer_ref(void) {
    return input_buffer;
}

int EMSCRIPTEN_KEEPALIVE lab_read_ram(int offset) { return READ_BYTE(work_ram, offset & 0xffff); }
uint8_t* EMSCRIPTEN_KEEPALIVE lab_state_ref(void) { return lab_state; }
int EMSCRIPTEN_KEEPALIVE lab_save_state(void) { return state_save(lab_state); }
int EMSCRIPTEN_KEEPALIVE lab_load_state(void) { return state_load(lab_state); }
int EMSCRIPTEN_KEEPALIVE lab_video_width(void) { return bitmap.viewport.w; }
int EMSCRIPTEN_KEEPALIVE lab_video_height(void) { return bitmap.viewport.h; }
void EMSCRIPTEN_KEEPALIVE lab_reset(void) { system_reset(); }

int EMSCRIPTEN_KEEPALIVE lab_fps(void) { return vdp_pal ? 50 : 60; }

int EMSCRIPTEN_KEEPALIVE lab_video_pitch(void) { return bitmap.pitch; }
int EMSCRIPTEN_KEEPALIVE lab_video_buffer_valid(void) {
    for (int i = 0; i < 4; i++) if (frame_allocation[i] != 0x5ac39e71u || frame_buffer[VIDEO_WIDTH * VIDEO_HEIGHT + i] != 0x5ac39e71u) return 0;
    return 1;
}

int EMSCRIPTEN_KEEPALIVE lab_set_pad_type(int player, int buttons) {
 if(player<0||player>1||(buttons!=0&&buttons!=3&&buttons!=6))return 0;
 config.input[player].padtype=buttons==6?DEVICE_PAD6B:buttons==3?DEVICE_PAD3B:(DEVICE_PAD2B|DEVICE_PAD3B|DEVICE_PAD6B);
 input_init();input_reset();return 1;
}

int EMSCRIPTEN_KEEPALIVE lab_set_region(int region) { if(region<0||region>4)return 0;selected_region=region;return 1; }
int EMSCRIPTEN_KEEPALIVE lab_get_region(void) { return region_code; }
int EMSCRIPTEN_KEEPALIVE lab_get_pad_type(int player) { return player<0||player>1?-1:input.dev[player*4]; }
unsigned int EMSCRIPTEN_KEEPALIVE lab_cpu_pc(void) { return m68k_get_reg(M68K_REG_PC); }
unsigned int EMSCRIPTEN_KEEPALIVE lab_rom_size(void) { return cart.romsize; }
