# The shim that starts Node inside the app. libnode.so and its headers are not in this repository: the build
# fetches them from nodejs-mobile's releases into kiosk/app/libnode/ (see .github/workflows/kiosk.yml).
cmake_minimum_required(VERSION 3.10)
project(frame-node)
# Node 24's V8 headers refuse anything older.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_library(frame-node SHARED src/main/cpp/frame-node.cpp)
include_directories(libnode/include/node/)
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)
find_library(log-lib log)
target_link_libraries(frame-node libnode ${log-lib})
