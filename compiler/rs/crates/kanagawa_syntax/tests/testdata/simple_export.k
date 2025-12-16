// Simple exported class for testing
module test

class Counter {
public:
    uint32 count;

    void reset() {
        count = 0;
    }
}

export Counter;
