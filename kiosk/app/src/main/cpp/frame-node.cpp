// Starts Node in this process, once, and sends what it prints to logcat (tag "frame-node"), which is the only
// place a server running inside a wall display can be read from.
#include <jni.h>
#include <string>
#include <cstring>
#include <cstdlib>
#include <unistd.h>
#include <pthread.h>
#include <android/log.h>
#include "node.h"

static int pipe_out[2], pipe_err[2];
static void *forward(void *arg) {
  int fd = *(int *) arg; char buffer[2048]; ssize_t n;
  while ((n = read(fd, buffer, sizeof buffer - 1)) > 0) {
    if (buffer[n - 1] == '\n') n--;
    buffer[n] = 0;
    __android_log_write(fd == pipe_err[0] ? ANDROID_LOG_WARN : ANDROID_LOG_INFO, "frame-node", buffer);
  }
  return nullptr;
}
static void logToLogcat() {
  setvbuf(stdout, nullptr, _IOLBF, 0); setvbuf(stderr, nullptr, _IONBF, 0);
  pipe(pipe_out); dup2(pipe_out[1], STDOUT_FILENO);
  pipe(pipe_err); dup2(pipe_err[1], STDERR_FILENO);
  pthread_t a, b;
  if (pthread_create(&a, nullptr, forward, &pipe_out[0]) == 0) pthread_detach(a);
  if (pthread_create(&b, nullptr, forward, &pipe_err[0]) == 0) pthread_detach(b);
}

extern "C" JNIEXPORT jint JNICALL
Java_co_rileysheehan_gingham_NodeServer_start(JNIEnv *env, jclass, jobjectArray arguments) {
  // Node wants argv as one contiguous block, the way a real command line is laid out.
  jsize count = env->GetArrayLength(arguments);
  size_t total = 0;
  for (jsize i = 0; i < count; i++) {
    auto text = (jstring) env->GetObjectArrayElement(arguments, i);
    const char *chars = env->GetStringUTFChars(text, nullptr);
    total += strlen(chars) + 1;
    env->ReleaseStringUTFChars(text, chars);
  }
  char *block = (char *) calloc(total, 1), *at = block;
  char **argv = (char **) calloc(count + 1, sizeof(char *));
  for (jsize i = 0; i < count; i++) {
    auto text = (jstring) env->GetObjectArrayElement(arguments, i);
    const char *chars = env->GetStringUTFChars(text, nullptr);
    strcpy(at, chars); argv[i] = at; at += strlen(chars) + 1;
    env->ReleaseStringUTFChars(text, chars);
  }
  logToLogcat();
  return (jint) node::Start((int) count, argv);
}
